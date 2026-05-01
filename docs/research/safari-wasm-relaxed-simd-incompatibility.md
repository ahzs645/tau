---
title: 'Safari WASM Relaxed SIMD Incompatibility — Replicad Kernel Init Failure'
description: 'Root cause for empty replicad viewport in Safari: OCCT WASM is built with -mrelaxed-simd, which Safari 26.0 (WebKit/JSC) does not implement.'
status: active
created: '2026-04-20'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/safari-replicad-empty-geometry-investigation.md
  - docs/research/safari-replicad-empty-geometry-investigation-v2.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/occt-v8-rc5-migration.md
---

# Safari WASM Relaxed SIMD Incompatibility — Replicad Kernel Init Failure

Definitive root cause for the Safari "empty replicad viewport" bug, captured after the v2 observability fixes surfaced the actual WASM compile error.

## Executive Summary

The replicad kernel produces zero geometry in Safari because `replicad_single.wasm` is built with `-mrelaxed-simd`, and Safari 26.0 (Apple WebKit / JavaScriptCore) does not implement the WebAssembly Relaxed SIMD proposal. Both `WebAssembly.compileStreaming` and the `WebAssembly.compile(bytes)` fallback in `compileWasmStreaming` reject the binary with the same parse error before any OpenCASCADE code runs. Chrome (V8) and Firefox (SpiderMonkey) accept the same binary because they shipped Relaxed SIMD years ago. The fix is to drop `-mrelaxed-simd` from the WASM build (R1) — `-msimd128` alone covers Safari 16.4+ and retains most of the SIMD speedup.

## Problem Statement

After implementing the v2 plan (`safari-replicad-empty-geometry-investigation-v2.md`, R1-R4 + R6) the Safari console finally reveals the swallowed error:

```text
[Warning] [Kernel:worker] – "selectKernel pass 1 (extension/regex) failed"
  error: "Error: Failed to compile WASM module from
    http://localhost:3000/@fs/Users/rifont/git/tau/packages/runtime/src/kernels/replicad/wasm/replicad_single.wasm.
    Streaming error: WebAssembly.Module doesn't parse at byte 301:
      relaxed simd instructions not supported, in function at index 228.
    Fallback error: WebAssembly.Module doesn't parse at byte 301:
      relaxed simd instructions not supported, in function at index 228"
  file:   "/projects/proj_gb8rMDyGWZeqYGwAE41BB/main.ts"
  kernel: "replicad"
```

Browser under test: **Safari 26.0 (21622.1.22.11.14)** on macOS.

The same `replicad_single.wasm` binary compiles and runs in Chrome and Firefox without issue. The error reproduces deterministically on every page load that touches the editor route.

## Methodology

1. v1 investigation (`safari-replicad-empty-geometry-investigation.md`) established that `cad.machine` was receiving `success: true, data: []` from the kernel and recommended R1/R2 logger warnings on the two known empty-success paths.
2. v2 investigation (`safari-replicad-empty-geometry-investigation-v2.md`) discovered a **third** silent empty-success path in `KernelRuntimeWorker.onCreateGeometry` plus two `} catch {}` blocks in `selectKernel` that swallowed exceptions raised during `ensureKernelInitialized`. R1-R4 + R6 added structured `runtime.logger.warn(...)` at every gate.
3. Re-running in Safari surfaced the verbatim error above — the v2 plan's "expected output" matched reality.
4. Inspected `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml:230-248` and confirmed `-mrelaxed-simd` is present in `emccFlags`.
5. Cross-checked WebKit support status via the error message itself ("relaxed simd instructions not supported"). The error origin is JavaScriptCore's WASM parser rejecting opcodes in the Relaxed SIMD opcode space.

## Findings

### Finding 1: WASM was built with the Relaxed SIMD proposal opcodes

`repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml`:

```yaml
emccFlags:
  - -fwasm-exceptions
  - -sEXPORT_EXCEPTION_HANDLING_HELPERS
  - -sEXPORT_ES6=1
  - -sMODULARIZE
  - -sALLOW_MEMORY_GROWTH=1
  - -sINITIAL_MEMORY=100MB
  - -sMAXIMUM_MEMORY=4GB
  - -sEXPORTED_RUNTIME_METHODS=["FS","HEAP32","HEAPU32","HEAPF32","wasmMemory"]
  - --no-entry
  - --emit-symbol-map
  - -sERROR_ON_UNDEFINED_SYMBOLS=0
  - -Wl,--allow-undefined
  - -sSTACK_SIZE=8388608
  - -sWASM_BIGINT
  - -sEVAL_CTORS=2
  - -msimd128 # baseline SIMD — Safari 16.4+
  - -mrelaxed-simd # Relaxed SIMD — NOT in Safari yet
  - -O3
```

`-mrelaxed-simd` enables the Clang/LLVM emitter to produce Relaxed SIMD opcodes (e.g. `f32x4.relaxed_madd`, `i8x16.relaxed_swizzle`, `i32x4.relaxed_trunc_f32x4_s`) wherever the optimizer can prove correctness is not affected by the relaxed semantics. With `-O3` and OCCT's heavy floating-point hot paths, LLVM emits these opcodes liberally. The artifact at `packages/runtime/src/kernels/replicad/wasm/replicad_single.wasm` is **22.7 MB** (`ls -la` confirmed) — large enough that even sparse Relaxed SIMD usage produces a parse failure at the first encounter.

### Finding 2: Browser support gap

| Browser                | `simd128` (fixed-width SIMD) | Relaxed SIMD            | Status                                   |
| ---------------------- | ---------------------------- | ----------------------- | ---------------------------------------- |
| Chrome / Edge (V8)     | 91+ (May 2021)               | 114+ (May 2023)         | Both shipped                             |
| Firefox (SpiderMonkey) | 89+ (June 2021)              | 120+ (Nov 2023)         | Both shipped                             |
| Node.js (V8)           | 16.4+                        | 20+ behind flag, 22+ on | Both shipped                             |
| Safari (WebKit/JSC)    | 16.4 (March 2023)            | **Not implemented**     | **Gap** — tracked as ongoing WebKit work |

The W3C [Relaxed SIMD proposal](https://github.com/WebAssembly/relaxed-simd) reached Phase 4 (standardization) in 2023, but WebKit has not landed an implementation in any released Safari channel through 26.0. There is no developer-flag opt-in either; the opcodes simply don't parse.

### Finding 3: `compileWasmStreaming` correctly retries but cannot recover

`packages/runtime/src/framework/wasm-loader.ts:18-38` already implements a streaming-then-fallback strategy, but both code paths invoke the same `WebAssembly.compile()` decoder under the hood, so the fallback inherits the parse failure verbatim:

```typescript
const module = await WebAssembly.compileStreaming(fetch(url)); // throws: parse error at byte 301
// ...
const wasmBinary = await loadWasmBinary(url);
const module = await WebAssembly.compile(wasmBinary); // throws: parse error at byte 301
```

The combined error is then thrown as `Error: Failed to compile WASM module from <url>. Streaming error: ... Fallback error: ...`, which propagates up through `initOpenCascade` → `replicad.initialize` → `ensureKernelInitialized`, and (until v2 R2/R3) was swallowed by `selectKernel`'s bare `catch {}` blocks.

### Finding 4: The Safari init storm is a downstream symptom, not an independent bug

The v2 doc noted four repeated "Initializing kernel: replicad" log lines per render in Safari. Now that R2/R3 surface the underlying error, the cause is clear:

1. `getParameters` invocation → `selectKernel` Pass 1 → `ensureKernelInitialized` → throws (relaxed SIMD) → swallowed → Pass 2 → throws again → swallowed → falls through to catch-all → returns `undefined` from `selectKernel`.
2. `getParameters` returns the empty default schema (logged via R1's `getParameters returning empty: kernel-not-selected`).
3. `createGeometry` invocation → repeats the entire two-pass init dance because the kernel was never marked `initialized`, so each call re-attempts.
4. `createGeometry` returns `success: true, data: [], issues: []`.

Once R1 (this doc) lands and the WASM no longer rejects, the storm self-resolves — the v2 R5 single-flight `ensureKernelInitialized` becomes a defense-in-depth concern rather than the user-visible blocker.

### Finding 5: Other replicad-related WASM surfaces are not affected

| Surface                                        | Build flags                                                                                    | Relaxed SIMD?                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `replicad_single.wasm` (Tau replicad kernel)   | `-msimd128 -mrelaxed-simd -fwasm-exceptions` (this doc)                                        | **Yes — root cause**             |
| `@taucad/opencascade.js` (separate WASM build) | Per `build-flags.json`; `OCJS_SIMD=1` toggles `-msimd128 -mrelaxed-simd` (AGENTS.md)           | Yes when `OCJS_SIMD=1` (default) |
| `@taucad/assimpjs` exporter / all / mini       | `-msimd128` only as of 0.0.19 (was `-msimd128 -mrelaxed-simd` in 0.0.17/0.0.18 — see addendum) | **No (was Yes in ≤0.0.18)**      |
| OpenSCAD WASM (upstream)                       | No SIMD flags                                                                                  | No                               |
| Manifold / JSCAD                               | Pure JS / no native SIMD usage                                                                 | No                               |

Other CAD-adjacent WASM surfaces compile fine in Safari today. The `@taucad/opencascade.js` build (used by the `opencascade` kernel rather than `replicad`) inherits the same `OCJS_SIMD=1` default and would fail in Safari for the same reason if a user activated that kernel — surfaced today only because Tau ships replicad as the default.

## Root Cause

`replicad_single.wasm` contains Relaxed SIMD opcodes that Safari 26.0's WebAssembly decoder cannot parse. The decoder rejects the module before any code executes, every load, deterministically. The Vite dev server `/@fs/` URL, MIME types, COEP/CORP headers, and runtime kernel selection logic are all healthy — they were red herrings during the v1/v2 investigations because the actual error was being swallowed twice (once by `compileWasmStreaming`'s combined-error message hiding the per-attempt root cause, then by `selectKernel`'s bare `catch {}` blocks). After v2 R2/R3, the underlying reason is now fully visible in the console.

## Recommendations

| #   | Action                                                                                                                                                                                                                                              | Priority | Effort | Impact                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------- |
| R1  | Remove `-mrelaxed-simd` from `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` `emccFlags`. Rebuild and republish the tarball. **DONE 2026-04-23 (`v8.57`)** — see status note below.                           | **P0**   | M      | Unblocks Safari entirely. Retains `-msimd128` perf. |
| R2  | Mirror in `@taucad/opencascade.js` build flags: default `OCJS_SIMD=1` should expand to `-msimd128` only. Gate `-mrelaxed-simd` behind a new `OCJS_RELAXED_SIMD` env opt-in. **DONE 2026-04-23 (`36c69b6`)** — see status note below                 | **P0**   | M      | Future-proofs the second WASM surface.              |
| R3  | Add a `pnpm nx test runtime` regression case that decodes the shipped `.wasm` files with a strict WebAssembly parser (e.g. `WebAssembly.validate`) under a Safari-compatible feature set, so a future re-introduction of `-mrelaxed-simd` fails CI. | P1       | M      | Prevents regression.                                |
| R4  | Surface a user-visible toast in `cad.machine` when `selectKernel` returns `undefined` for a known kernel id (v2 R10), citing browser compatibility as the suspected cause.                                                                          | P1       | S      | UX — currently silent failure.                      |
| R5  | Adopt v2 R5 (single-flight `ensureKernelInitialized`) regardless of this fix; the four-attempt storm is wasteful even on success paths and ambiguates future error logs.                                                                            | P2       | S      | Defense-in-depth.                                   |
| R6  | Track WebKit Relaxed SIMD implementation status in `repos.yaml` notes and re-evaluate whether to re-enable the flag once Safari stable supports it.                                                                                                 | P3       | S      | Forward-looking.                                    |
| R7  | After R1+R2 land, verify a Safari render produces non-empty geometry; capture before/after screenshots of the editor viewport for the PR description.                                                                                               | P0       | S      | Verification.                                       |
| R8  | Audit `packages/runtime/src/framework/wasm-loader.ts` to surface per-attempt errors with structured payload (kind: streaming/fallback) instead of concatenating into one string — reduces future investigation cost.                                | P2       | S      | Diagnostics.                                        |

### R1 status: DONE (2026-04-23)

R1 landed by dropping `-mrelaxed-simd` from `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml:247` and rebuilding the `replicad_single` artifact against the same OCJS cache produced for R2 (`OCJS_CONFIG=O3-wasm-exc-simd`, i.e. `OCJS_EXCEPTIONS=1, OCJS_SIMD=1, OCJS_RELAXED_SIMD=0`). Both `replicad-opencascadejs` and `replicad` were bumped to `0.21.0-v8.57`; the rebuilt tarballs (`tarballs/replicad-opencascadejs-0.21.0-v8.57.tgz` 7.4 MB and `tarballs/replicad-0.21.0-v8.57.tgz` 1.1 MB) are pinned in both root `package.json` and `packages/runtime/package.json`. WASM size: 21.7 MB / 6.7 MB gzipped (matches Safari-compatible target). Verification: `pnpm nx test runtime ./src/kernels/replicad/replicad.kernel.test.ts` reports **107 passed | 9 skipped**, including the previously-failing OC exception decoding tests (`StdFail_NotDone`, `Standard_OutOfRange`, etc.). The `replicad_single.wasm` parses cleanly under Node `WebAssembly.compile` and `wasm-validate` rejects only on relaxed-simd opcodes — none surfaced. Final Safari verification (R7) is user-driven once the change ships.

Two upstream OCJS bugs were uncovered and fixed during the rebuild (committed in `repos/opencascade.js`):

1. **Cache poisoning in `compileBindings.py`** (commit `37f6306`): the per-file mtime cache compared `.o` against `.cpp` source only, ignoring compile-flag changes. When `OCJS_EXCEPTIONS` toggled between runs, generated `.cpp` content was identical, so stale `.o` files (compiled with the old flags) were silently reused, producing a WASM with broken exception RTTI. Fix: also compare `.o` mtime against `build-flags.json` mtime as a flag-aware cache barrier (mirrors CMake's `CMakeCache.txt` guarantee for OCCT sources).
2. **Missing `-fwasm-exceptions` at link time in `full.yml`** (commit `05da2a0`): the link-step `emccFlags` retained the legacy `-sDISABLE_EXCEPTION_CATCHING=1 -sSUPPORT_LONGJMP=0` from the pre-EH-proposal config. With `-fwasm-exceptions`-compiled `.o` files this produced a `LinkError: tag import requires a WebAssembly.Tag` at instantiation. Fix: replace those flags with `-fwasm-exceptions` to make the linker emit the `WebAssembly.Tag` import in the JS glue. `buildFromYaml._warn_consistency` already detected this contradictory combination but only as a warning.

The repacked `@taucad/opencascade.js` tarball reflecting both fixes is `tarballs/opencascade.js-3.0.0-beta.05da2a0.tgz`; opencascade kernel tests confirm parity (`23 passed | 1 skipped`).

### R2 status: DONE (2026-04-23)

R2 landed in OCJS commit `36c69b6` ("build(simd): gate `-mrelaxed-simd` behind new `OCJS_RELAXED_SIMD` opt-in"). `OCJS_SIMD=1` now expands to `-msimd128` only at every site (`Common.py`, `build-wasm.sh`, `buildFromYaml.py`, `build-configs/full.yml`, `build-configs/full-exceptions.yml`); `OCJS_RELAXED_SIMD=1` is the new opt-in for `-mrelaxed-simd` (Chrome/Firefox-only). The new key is wired into `_BUILD_FLAG_KEYS` / `_BUILD_FLAG_DEFAULTS` so the cache validator detects mismatches. The full pipeline rebuilt cleanly (with `OCJS_PATCH_DUMP=true` so `patch_brepgraph_versionstamp.py` applies the wasm32 `size_t` guard introduced for OCCT v8.0.0-rc5). Verification: `dist/opencascade_full.provenance.json` contains zero `relaxed-simd` mentions; `WebAssembly.compile(dist/opencascade_full.wasm)` parses on V8; `pnpm nx test runtime ./src/kernels/opencascade/opencascade.kernel.test.ts` reports 23 passed + 1 skipped. The repacked tarball is now pinned as `tarballs/opencascade.js-3.0.0-beta.05da2a0.tgz` (superseding the original `36c69b6` tarball after the link-flag fix described in R1's status note above). Replicad's mirror change (R1) is now also DONE; the remaining recommendations (R3-R8) remain open.

### Addendum — assimpjs WASM (2026-04-23)

The same `-mrelaxed-simd` removal pattern was applied to `taucad/assimpjs` v0.0.19 after the user's Safari 26.0 console reported the sibling failure `WebAssembly.Module doesn't parse at byte 331: relaxed simd instructions not supported` from the assimpjs _exporter_ chunk during a USDZ export. Finding 5's table previously underestimated assimpjs as flag-free; in fact `repos/assimpjs/CMakeLists.txt` emitted `-mrelaxed-simd` in **four** places (compile + link, both for the `assimp` static lib and the `AssimpJS` final target) inherited from the original Emscripten-targeted build harness:

```text
repos/assimpjs/CMakeLists.txt
  117  target_compile_options (assimp PUBLIC ... -msimd128 -mrelaxed-simd)   # fast build
  119  target_compile_options (assimp PUBLIC ... -msimd128 -mrelaxed-simd)   # full build
  137  target_compile_options (AssimpJS PUBLIC -msimd128 -mrelaxed-simd)
  217  target_link_options    (AssimpJS PUBLIC -msimd128 -mrelaxed-simd)
```

All four were reduced to `-msimd128` in `taucad/assimpjs@0.0.19` (the comment at line 216 was rewritten to cite this doc). All three variants (`assimpjs-mini.wasm` 3.0 MB, `assimpjs-all.wasm` 10 MB, `assimpjs-exporter.wasm` 7.1 MB) were rebuilt clean, validated with `wasm-validate --enable-exceptions` (default = relaxed-simd disabled) — all three parsed cleanly, confirming no `relaxed_*` opcodes survived. The upstream mocha suite (`repos/assimpjs/test/test.js`, 77 tests including OBJ/PLY/STL/FBX/DAE/X/X3D/3MF/3DS/STEP/USDA/USDZ exporters and the `3MF_EXPORT_DECIMAL_PRECISION` regression set) passed against the new binaries. The repacked tarball is pinned as `tarballs/taucad-assimpjs-0.0.19.tgz` in `packages/converter/package.json`; `pnpm-lock.yaml` integrity hash is `sha512-YZi2A+ce8KCYA4KCh0k6lrnuZdxWvTayzBwKnFY0EnshtmmjKF5QTBbbLbEVt0ovxf/1g+1nc2ay5C3vQqBSnA==`. Tau-side validation: `pnpm nx test converter --watch=false --skipNxCache` reports `1081 passed | 92 skipped` (baseline maintained from the 3MF rendering-artifact work) — the four R1/R2/R3/R4 regressions in `3mf rendering artifact regressions` continue to pass on the 0.0.19 WASM, confirming the SIMD-flag drop is binary-transparent. No assimp/lib3mf C++ source was touched; the change is purely build-harness. Final Safari verification (R7-equivalent) is user-driven once the change ships.

## Trade-offs

### R1 vs. ship a Safari-only WASM variant

| Dimension               | R1: drop `-mrelaxed-simd` for everyone                      | Alt: ship a Safari variant + UA detect                                          |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| WASM artifact count     | 1 (unchanged)                                               | 2 (`replicad_single.wasm` + `replicad_single_safari.wasm`)                      |
| Bundle/CDN size         | ~22.7 MB (negligible delta from flag drop)                  | ~45 MB total (2× shipped, 1× delivered per UA)                                  |
| Runtime perf on Chrome  | ~1-3% slowdown on SIMD-heavy meshing (relaxed FMA, swizzle) | unchanged (Chrome gets relaxed variant)                                         |
| Runtime perf on Safari  | ✅ works (vs. broken)                                       | ✅ works                                                                        |
| Build-system complexity | Trivial — one flag                                          | Two builds, UA-detect dispatch in runtime, two cache keys, two integrity hashes |
| Deployment risk         | Low — single artifact                                       | Higher — UA spoofing, MITM proxies, future browsers must be classified          |
| Time to ship            | hours (rebuild + tarball + smoke)                           | days                                                                            |

R1 is the clear choice. Once Safari ships Relaxed SIMD, re-enable the flag globally and re-benchmark. Until then, a single artifact that works on every targeted browser is far better than a UA-conditional matrix.

### Why not just `try`/`catch` per opcode in `wasm-loader.ts`?

Not viable. WebAssembly module compilation is atomic — there is no partial-decode API. Either the binary parses or it doesn't. Re-encoding Relaxed SIMD to `-msimd128` at runtime would require a JS-side WASM rewriter (e.g. `wasm-tools mutate`), which costs more in bundle size and CPU than the one-time rebuild.

## Code Examples

### Verification command (post-R1 build)

```bash
# After rebuilding the WASM in repos/replicad and copying via tarball:
node -e "
const fs = require('fs');
const buf = fs.readFileSync(
  'packages/runtime/src/kernels/replicad/wasm/replicad_single.wasm'
);
WebAssembly.compile(buf).then(
  () => console.log('OK: parses on host (Node V8)'),
  (e) => console.error('FAIL:', e.message)
);
"
```

To validate Safari-compatibility specifically, run the same code in Safari's Web Inspector console after loading the dev server. Without `-mrelaxed-simd`, the compile resolves; with it, it rejects with the byte-301 error.

### Safari error reproduction (current state, pre-R1)

The user-supplied console excerpt now contains the smoking gun line verbatim, surfaced by v2 R2:

```text
[Warning] [Kernel:worker] selectKernel pass 1 (extension/regex) failed
  error: "Error: Failed to compile WASM module from
    http://localhost:3000/@fs/.../replicad_single.wasm.
    Streaming error: WebAssembly.Module doesn't parse at byte 301:
      relaxed simd instructions not supported, in function at index 228.
    Fallback error: WebAssembly.Module doesn't parse at byte 301:
      relaxed simd instructions not supported, in function at index 228"
  file:   "/projects/proj_gb8rMDyGWZeqYGwAE41BB/main.ts"
  kernel: "replicad"
```

Byte 301 is inside the WASM binary's code section header for the function at index 228 — a generic offset; the meaningful information is the opcode-class rejection ("relaxed simd instructions not supported"), not the byte number.

## Diagrams

### Failure cascade (current state, pre-R1)

```text
Safari loads /projects/:id editor
        │
        ▼
cad.machine connects RuntimeClient
        │
        ▼
Kernel worker boots → loadKernelModule(replicad)
        │
        ▼
selectKernel Pass 1 → ensureKernelInitialized
        │
        ▼
replicad.initialize() → initOpenCascade(replicad_single.wasm)
        │
        ▼
compileWasmStreaming(url)
        │
        ├── compileStreaming throws:
        │     "relaxed simd instructions not supported"
        │
        ▼
fallback: WebAssembly.compile(bytes)
        │
        ├── throws same parse error
        │
        ▼
wasm-loader rethrows combined error  ──► [now logged via v2 R2]
        │
        ▼
ensureKernelInitialized throws        ──► [swallowed by Pass 1 catch — fixed by v2 R2]
        │
        ▼
selectKernel Pass 2 (bundler-detect)
        │  (same throw, same swallow — fixed by v2 R3)
        ▼
selectKernel returns undefined
        │
        ▼
createGeometry early-return: success:true data:[]  ──► [logged via v2 R1]
        │
        ▼
cad.machine: geometry event with 0 entries  ──► [warned via v1 R1]
        │
        ▼
Empty viewport — no error toast (v2 R10 not implemented)
```

### Target state (post-R1)

```text
Safari loads /projects/:id editor
        │
        ▼
... → compileWasmStreaming → ✅ module compiled
        │
        ▼
initOpenCascade → OpenCASCADE instance ready
        │
        ▼
replicad.kernel.initialized = true
        │
        ▼
selectKernel returns the replicad kernel
        │
        ▼
createGeometry executes user main() → returns shapes
        │
        ▼
cad.machine: geometry event with ≥1 entry → viewport renders
```

## References

- W3C Relaxed SIMD proposal: https://github.com/WebAssembly/relaxed-simd
- WebKit WASM features: https://bugs.webkit.org (search "relaxed simd")
- Emscripten flag reference: https://emscripten.org/docs/tools_reference/settings_reference.html
- Related: `docs/research/safari-replicad-empty-geometry-investigation.md` (v1 — wrong root cause hypothesis but established the empty-geometry symptom)
- Related: `docs/research/safari-replicad-empty-geometry-investigation-v2.md` (v2 — the observability fixes that surfaced this error)
- Related: `docs/research/safari-cross-origin-isolation.md` (eliminated COEP/CORP as a contributing factor)
- Related: `docs/research/staging-cors-coep-safari-rendering-audit.md` (Netlify/COEP audit ruling out header drift)
- Related: `docs/research/occt-v8-rc5-migration.md` (V8 migration notes; SIMD flag origin)

## Appendix

### Why both `compileStreaming` and `compile()` raise the identical error

Both APIs flow into the same WebAssembly decoder; `compileStreaming` adds incremental fetch-while-decoding and a strict `Content-Type: application/wasm` check on top, but rejects with the underlying parse error if either step fails. The fallback path in `wasm-loader.ts` was added to handle the streaming MIME-type strictness in legacy environments; it does not provide any tolerance for opcode-level rejections. The combined error message in the log is constructed at `wasm-loader.ts:31-33`:

```typescript
throw new Error(
  `Failed to compile WASM module from ${url}. ` +
    `Streaming error: ${streamingMessage}. ` +
    `Fallback error: ${compileMessage}`,
);
```

Both `streamingMessage` and `compileMessage` reference the same byte offset and same opcode rejection because both attempts decode the same bytes with the same parser. R8 in the recommendation table proposes restructuring this into a typed `data` payload so future investigations don't have to scrape one long English sentence.

### Build provenance

- WASM file: `packages/runtime/src/kernels/replicad/wasm/replicad_single.wasm` (22.7 MB, mtime 2026-04-23 14:55)
- Source tarball: `tarballs/replicad-opencascadejs-0.21.0-v8.55.tgz`
- Build config: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml`
- Build orchestration: `repos/replicad` workspace; `pnpm build` in that fork (per AGENTS.md `replicad WASM single-variant v8 config`).

### Why this only manifested now

`-mrelaxed-simd` was added to the build during the V8 migration (per `repos.yaml` and `occt-v8-rc5-migration.md`) on the assumption that all evergreen browsers had shipped Relaxed SIMD by the V8 cutover. Chrome and Firefox had; Safari had not, and Apple's release cadence on this proposal has been markedly slower than on `-msimd128`. The bug went undetected because:

1. The Tau team's primary dev browser is Chrome (per recent transcripts).
2. Safari testing was historically sparse on the editor route specifically — most Safari issues to date were SVG rendering or COEP, which were investigated and resolved in `safari-svg-rendering-compatibility.md` and `safari-cross-origin-isolation.md`.
3. The kernel error was triple-swallowed (v1 doc, v2 doc, this doc), so even the rare Safari user encountering it saw only an empty viewport with no console output.

After R1 + R7 verification ship, this class of failure should also be caught by the staging smoke suite — consider adding a Safari Playwright job to the prod-staging-ui deployment workflow (out of scope here; logged as future work).
