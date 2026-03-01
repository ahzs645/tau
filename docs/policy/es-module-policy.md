# ES Module Asset Injection Policy

Standard practice for loading heavy assets (WASM binaries, Emscripten JS glue, large modules) in a way that enables code-splitting, tree-shaking, and runtime injection.

## Problem

Static top-level imports of variant modules force all variants into the bundle, regardless of which is actually used at runtime:

```typescript
// BAD: both variants always bundled (~225KB total)
import single from 'replicad-opencascadejs/src/replicad_single.js';          // ~112KB
import exceptions from 'replicad-opencascadejs/src/replicad_with_exceptions.js'; // ~113KB
```

This pattern prevents consumers from shipping a minimal bundle when they only need one variant.

## The Two-Tier Dynamic Import Pattern

### Tier 1: Static-string dynamic imports (presets)

For known, build-time-resolvable variants, use `import()` with a **static string literal**. All major bundlers (Vite/Rollup, webpack, esbuild) recognize this pattern and create a **code-split chunk** that is loaded on-demand:

```typescript
async function loadBindings(preset: 'single' | 'single-exceptions') {
  if (preset === 'single-exceptions') {
    return import('replicad-opencascadejs/src/replicad_with_exceptions.js');
  }
  return import('replicad-opencascadejs/src/replicad_single.js');
}
```

**Why this works**: The bundler statically detects each `import()` target at build time, creates separate chunks, and handles CJS-to-ESM transformation automatically. Only the selected chunk is downloaded at runtime.

### Tier 2: Variable dynamic imports (custom URLs)

For runtime-provided URLs (benchmarking, CI, custom WASM builds), use `import()` with a runtime variable and a bundler-ignore comment:

```typescript
async function loadCustomBindings(url: string) {
  return import(/* @vite-ignore */ url);
}
```

**Bundler compatibility for ignore comments**:

| Bundler | Comment | Behavior |
|---|---|---|
| Vite | `/* @vite-ignore */` | Suppresses warning, preserves as runtime import |
| Rollup | _(none needed)_ | Warns, preserves as-is (suppress via `onwarn`) |
| esbuild | _(none needed)_ | Warns, preserves as-is |
| webpack | `/* webpackIgnore: true */` | Suppresses warning, preserves as runtime import |

**CJS limitation**: Runtime `import(url)` in browsers requires the target to be an ES module. CJS-to-ESM transformation only happens for static-string imports that bundlers process at build time. In Node.js, `import()` handles CJS files natively. Custom URL injection is therefore primarily a **Node.js-first** capability (benchmarks, CI, testing).

## WASM Binary URL Pattern

For WASM binaries loaded via `fetch()` / `WebAssembly.compileStreaming()`, use the universal `new URL()` pattern with a static string literal:

```typescript
const wasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href;
```

This pattern is recognized by all major bundlers ([web.dev reference](https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers)). The bundler copies the asset to the output directory and rewrites the URL at build time.

**Key constraint**: The path must be a static string literal, not a variable. Variables prevent the bundler from detecting and copying the asset.

## Serialization Constraint

When options cross a `postMessage` boundary (e.g., main thread to Web Worker), they are serialized via the structured clone algorithm. This means:

- Strings (URLs) survive serialization
- Functions, URL objects, and module references do **not**

Therefore, WASM configuration must be expressed as plain strings (URL strings), not as functions or object references. Preset resolution (mapping a preset name to URLs and module imports) must happen on the worker side where `import.meta.url` resolves correctly relative to the kernel module.

## Putting It Together

The recommended architecture for factory options that select between heavy asset variants:

1. **Consumer API**: Union type of preset strings and a custom config object
   ```typescript
   type WasmOption = 'single' | 'single-exceptions' | { wasmUrl: string; wasmBindingsUrl: string };
   ```

2. **Factory**: Passes the raw option through as a serializable value (string or plain object)

3. **Worker-side resolution**: Maps presets to URLs using `new URL()` and loads modules via static-string `import()`. Custom configs use variable `import()` with ignore comments.

4. **Pure initialization function**: Receives the already-resolved URL and loaded module factory. Zero module-level state, zero static imports of variant modules.

## Bundler Configuration: The WASM Inlining Footgun

The `new URL()` pattern above is processed by Vite at build time. Vite applies its `assetsInlineLimit` setting to decide whether to **inline** the referenced file as a `data:` URL or **emit** it as a separate hashed asset. For WASM binaries, inlining is catastrophic.

### Why WASM Inlining Breaks Caching

When Vite inlines a WASM binary, three things go wrong simultaneously:

1. **Base64 bloat**: A 20 MB `.wasm` file becomes a ~27 MB base64 string embedded in a JS chunk (33% overhead). The containing chunk balloons from ~100 KB to tens of megabytes.

2. **V8 bytecode cache overflow**: Chrome's `GeneratedCodeCache` has a per-entry size limit (~20-30 MB, approximately 1/8 of the total cache size). When V8 produces a bytecode cache for a bloated chunk (e.g., 59.6 MB for a 57 MB chunk), Chrome's storage layer **silently drops** it. There is no error, no warning — the cache write simply doesn't persist. On the next page load, V8 recompiles the entire chunk from source.

3. **No streaming compilation**: Inlined WASM is a base64 string that must be decoded at runtime, not a fetch-able resource. `WebAssembly.compileStreaming()` cannot be used. V8's Liftoff compiler cannot begin compilation until the entire string is parsed and decoded.

### The `assetsInlineLimit` Callback Trap

Vite's `assetsInlineLimit` callback has **unintuitive return semantics**:

| Return value | Behavior |
|---|---|
| `true` | **Force inline** — regardless of file size |
| `false` | **Never inline** — always emit as separate file |
| `undefined` | Use the default 4 KB threshold |
| `number` | Inline only if file is smaller than this value |

A common mistake is writing a callback that returns a boolean to exclude one file type, inadvertently force-inlining everything else:

```typescript
// WRONG: returns true for all non-SVG files, including multi-MB WASM binaries
assetsInlineLimit(file) {
  return !file.endsWith('.svg');
}
```

The correct pattern:

```typescript
// CORRECT: exclude SVGs from inlining, use default threshold for everything else
assetsInlineLimit(file) {
  if (file.endsWith('.svg')) {
    return false;
  }
  return undefined; // default 4 KB threshold applies
}
```

### Verifying Correct Build Output

After building, check that WASM files appear as separate assets in the build output:

```
build/client/assets/replicad_single-BF2EjB3m.wasm     19,885 kB
build/client/assets/esbuild-Cpd5nU_H.wasm              13,524 kB
build/client/assets/kcl_wasm_lib_bg-BdkQwGXP.wasm      14,858 kB
```

If `.wasm` files are **absent** from the asset list, they are being inlined. Check `assetsInlineLimit`.

Also verify that JS chunks containing WASM bindings are small (< 100 KB), not multi-MB:

```
build/client/assets/replicad_single-DiVE9Huy.js         67 kB  ✓ (bindings only)
build/client/assets/replicad.kernel-Ck9z3i8a.js         307 kB ✓ (kernel code only)
```

### Chunk Size Budget for V8 Caching

To ensure V8 bytecode caching works reliably across browsers and cache configurations:

- **Hard limit**: Keep individual JS chunks under **15 MB** (bytecode is ~1.05x source size, and cache limits vary by browser/configuration).
- **Practical target**: Keep WASM-adjacent JS chunks under **500 KB** by emitting all WASM as separate files. The JS chunk should contain only the bindings/glue code.
- **Diagnostic**: If `chrome://tracing` shows `v8.compileModule` with `cacheKind=ABSENT` on reload 3+, the bytecode cache is being rejected. Check chunk sizes.

### Impact: Verified Performance Data

| Metric | With WASM inlining | Without (fixed) |
|---|---|---|
| `replicad.kernel` chunk size | 57 MB | 308 KB |
| V8 compile time (per reload) | 232ms | < 1ms (cached) |
| `kernel.select` latency | 936ms-1.15s | < 1ms |
| Total render time | 1.26-1.56s | 229ms |

> For the full investigation, see [Dynamic ES Module Research](../research/dynamic-es-modules.md).

## WASM Module Reuse Across Workers

Even with WASM files correctly emitted as separate assets, there is an inherent per-worker-creation cost due to V8's streaming pipeline:

| Cost | Duration | Cause |
|---|---|---|
| `wasm.compile` | ~79ms | Fetching 22 MB through data pipe + streaming finalization, even with cache hits |
| `wasm.emscripten-init` | ~44ms | C++ global constructors + Emscripten FS setup |
| **Total per restart** | **~123ms** | Unavoidable when a worker is terminated and recreated |

V8's NativeModuleCache (process-level) caches compiled WASM across workers, but `WebAssembly.compileStreaming(fetch(url))` cannot short-circuit the fetch — all bytes must flow through Chrome's Mojo data pipe even on a cache hit.

### Prefer keeping workers alive

When users switch between projects that use the same kernel, **do not terminate the worker**. Send a reset command instead. The WASM module, Emscripten instance, and initialized state all survive, reducing WASM init from ~123ms to 0ms.

```typescript
// WRONG: destroys V8 isolate, all WASM state lost
worker.terminate();
// Then later: new Worker(url) → full WASM init pipeline (~123ms)

// RIGHT: keep worker alive, reset kernel state
worker.postMessage({ type: 'reset' });
// WASM stays warm → 0ms init overhead
```

### When workers must restart: transfer pre-compiled modules

If a worker must be recreated (crash recovery, kernel type change), avoid `compileStreaming(fetch())` by transferring a pre-compiled `WebAssembly.Module` from the main thread:

```typescript
// Main thread: compile once at startup, hold reference
const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl));

// Transfer to new worker (structured-cloneable, no copy in V8)
worker.postMessage({ type: 'init', wasmModule });

// Worker side: instantiate directly, skip fetch+streaming
const instance = await WebAssembly.instantiate(wasmModule, imports);
```

`WebAssembly.Module` is structured-cloneable. V8 internally shares compiled code via the NativeModuleCache — no actual byte copying occurs.

### V8 isolate cache boundaries

| Cache Level | Scope | Survives Worker Termination |
|---|---|---|
| NativeModuleCache | Renderer process | Yes |
| GeneratedCodeCache (disk) | Browser profile | Yes |
| Compiled instance (in-isolate) | Worker V8 isolate | **No** |

> For the full trace analysis, see [Dynamic ES Module Research](../research/dynamic-es-modules.md#8-residual-wasm-init-cost-post-fix).

## Anti-patterns

- **Top-level static imports of variant modules** -- forces all variants into the bundle
- **Module-level URL constants for unused variants** -- references assets that may never be needed
- **Passing functions through `postMessage`** -- functions are not structured-cloneable
- **Dynamic `import(variable)` without ignore comments** -- produces bundler warnings in CI/CD
- **Assuming CJS works with browser `import()`** -- it does not; only Node.js handles CJS via `import()`
- **`assetsInlineLimit` returning `true` for WASM files** -- inlines multi-MB binaries into JS, breaking V8 bytecode cache and disabling streaming compilation
- **JS chunks > 20 MB containing inlined binary data** -- exceeds Chrome's `GeneratedCodeCache` per-entry limit, causing silent cache rejection and full recompilation on every page load
- **Terminating workers between same-kernel project switches** -- destroys the V8 isolate and forces full WASM re-init (~123ms) even when the same WASM module is needed
- **Calling `compileStreaming(fetch(url))` when a `WebAssembly.Module` is already available** -- the streaming pipeline has ~79ms of inherent overhead even on cache hits; transfer pre-compiled modules via `postMessage` instead
