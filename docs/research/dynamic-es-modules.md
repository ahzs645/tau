# Dynamic ES Module Loading in Web Workers: Performance Research

> Investigation into why the kernel worker startup takes ~1.3s on every page reload
> in production builds, despite using identical build assets across reloads.

## Executive Summary

The **root cause** is a misconfigured `assetsInlineLimit` in `vite.config.ts` that
force-inlines `.wasm` files as base64 data URLs into JavaScript chunks. This inflates
the `replicad.kernel` chunk to **57 MB** (containing two ~20 MB WASM binaries as
base64 strings), which exceeds Chrome's per-entry bytecode cache limit (~20-30 MB).
V8 recompiles 57 MB of JavaScript on **every page load** (232ms), because the
produced 59.6 MB bytecode cache is silently rejected by Chrome's `GeneratedCodeCache`
disk backend.

**Fix**: Change `assetsInlineLimit` to stop force-inlining WASM binaries. This reduces
the chunk from 57 MB to ~308 KB, enables bytecode caching, and drops compile time from
232ms to near-instant. Verified: after fix, `kernel.select` disappears from telemetry
entirely and render time drops to 229ms (dominated by actual CAD computation).

---

## 1. Problem Statement

After introducing ES module dependency injection for kernel plugins (dynamically
loading kernel modules via `import(/* @vite-ignore */ moduleUrl)` instead of
statically bundling them into a single worker), the kernel startup time in production
builds regressed from fast (~200ms total) to consistently slow (~1.3s), with
`kernel.select` alone taking ~1s on every page reload.

### Observed Telemetry (5 consecutive reloads, same build assets)

| Span | Time |
|---|---|
| `kernel.bootstrap` | 58-83ms |
| `kernel.bundler-init` | 79-120ms |
| `kernel.select` | 936ms-1.15s |
| ├ `kernel.load-module` | 492-579ms |
| ├ `replicad.resolve-bindings` | 90-194ms |
| ├ `wasm.compile` | 253-314ms |
| └ `wasm.emscripten-init` | 38-49ms |
| **Total `kernel.resolve-deps`** | **1.26-1.56s** |

The startup penalty is **consistent across reloads** — no improvement from browser
caching despite identical asset URLs.

---

## 2. Root Cause Analysis

### 2.1 The `assetsInlineLimit` Bug

In `apps/ui/vite.config.ts`:

```typescript
build: {
  assetsInlineLimit(file) {
    // Don't inline SVGs
    return !file.endsWith('.svg');
  },
}
```

Vite's `assetsInlineLimit` callback semantics:
- Return `true` → **force inline** (regardless of size)
- Return `false` → **never inline**
- Return `undefined` → use default size threshold (4096 bytes)

The current code returns `true` for all non-SVG files, including `.wasm` files.
This causes Vite to base64-encode WASM binaries (19-22 MB each) and embed them as
`data:application/wasm;base64,...` strings inside JavaScript chunks.

### 2.2 Chunk Size Impact

Build output analysis (`apps/ui/build/client/assets/`):

| Chunk | Total Size | Inline Data | Actual Code |
|---|---|---|---|
| `replicad.kernel-CHV4DDRI.js` | **57 MB** | 56.7 MB (2 WASM + sourcemap + font) | ~300 KB |
| `replicad_with_exceptions-*.js` | 30 MB | 29.6 MB (1 WASM) | ~100 KB |
| `replicad_single-*.js` | 25 MB | 25.3 MB (1 WASM) | ~100 KB |
| `esbuild.bundler-*.js` | 17 MB | 17.2 MB (1 WASM) | ~100 KB |
| `kcl_wasm_lib-*.js` | 19 MB | — (code-heavy) | ~19 MB |

The `replicad.kernel` chunk contains **both** OpenCASCADE WASM variants inlined as
base64 data URLs:
- `data:application/wasm;base64,...` — 29.63 MB (exceptions variant)
- `data:application/wasm;base64,...` — 25.29 MB (single variant)

No `.wasm` files were emitted in the build output. All WASM was inlined.

### 2.2.1 How Vite Detects WASM References

The Emscripten-generated bindings files (e.g. `replicad_single.js`) use Vite's
`new URL()` asset reference pattern to locate their companion WASM binary:

```javascript
return new URL("replicad_single.wasm", import.meta.url).href
```

When Vite encounters `new URL(staticPath, import.meta.url)`, it:
1. Resolves the referenced file relative to the source module
2. Checks `assetsInlineLimit` to decide whether to inline or emit
3. If inlining: replaces the expression with a `data:` URL containing the
   base64-encoded file contents
4. If emitting: copies the file to `/assets/` with a content hash and
   replaces the expression with the hashed URL

With `assetsInlineLimit` returning `true` for `.wasm` files, step 3 was
triggered for every WASM binary, embedding 19-22 MB of base64 data into
each JavaScript chunk that referenced a WASM file.

### 2.3 V8 Bytecode Cache Failure

Chrome traces (`chrome://tracing`) reveal the caching failure chain:

**Step 1: Compile (every load)**
```
v8.compileModule  replicad.kernel-CHV4DDRI.js
  dur=232ms  cacheKind=ABSENT  consumedCacheSize=ABSENT
```
No cache metadata fields are present — the cache was never consulted.

**Step 2: Cache Production (fires once)**
```
v8.produceModuleCache  replicad.kernel-CHV4DDRI.js
  producedCacheSize=59,663,120 bytes (59.6 MB)
  dur=42.8ms
```
V8 serializes 59.6 MB of bytecode and hands it to Chrome's storage layer.

**Step 3: Cache Storage (silently fails)**
The 59.6 MB entry exceeds Chrome's `GeneratedCodeCache` per-entry limit. The write
fails silently. No cache is stored.

**Step 4: Next reload (cache miss)**
```
v8.compileModule  replicad.kernel-CHV4DDRI.js
  dur=228ms  cacheKind=ABSENT  consumedCacheSize=ABSENT
```
Still no cache. The 232ms compile repeats on every reload.

### 2.4 Comparison with Working Modules

Modules with bytecode caches ≤20 MB work correctly:

| Module | JS Size | Cache Size | Cached? | Compile Time |
|---|---|---|---|---|
| `esbuild.bundler` | 17 MB | 18.0 MB | **YES** (always) | 5ms |
| `kcl_wasm_lib` | 19 MB | 19.8 MB | **YES** (after 1st load) | 0.7ms |
| `kcl_wasm_lib_bg` | 19 MB | 19.8 MB | **YES** (always) | <0.1ms |
| `schemas` | 107 KB | 122 KB | **YES** (always) | 0.2ms |
| **`replicad.kernel`** | **57 MB** | **59.6 MB** | **NEVER** | **232ms** |

The threshold appears to be ~20-30 MB of bytecode. Everything below caches fine.
The 59.6 MB `replicad.kernel` cache is 3x over the limit.

### 2.5 Worker Module Caching Behavior

Chrome trace analysis across 3 page reloads reveals two classes of worker modules:

**Cached modules** (have `cacheKind: normal` from load 1):
These had their bytecode cache established in prior sessions and are consumed
by workers. All have cache sizes ≤ 18 MB.

**Never-cached modules** (no `cacheKind` field on any load):
1. **Worker entry points** — Chrome excludes the top-level module script of
   `new Worker(url, {type: 'module'})` from code caching. This is the
   `kNoCacheBecauseModule` reason in V8's `ScriptCompiler::NoCacheReason` enum.
2. **Small utility modules** — likely excluded by `kNoCacheBecauseScriptTooSmall`.
3. **`replicad.kernel`** — excluded because its cache exceeds the storage limit.

---

## 3. V8 Code Caching Internals

### 3.1 Cache Lifecycle (cold → warm → hot)

V8's code cache follows a three-phase lifecycle:

1. **Cold**: Module is compiled from source. No cache available.
2. **Warm**: After execution, V8 serializes the compiled bytecode via
   `ScriptCompiler::CreateCodeCache()` (for modules:
   `CreateCodeCache(Local<UnboundModuleScript>)`). The embedder (Chrome/Blink)
   stores this as metadata in the `GeneratedCodeCache` disk backend.
3. **Hot**: On subsequent loads, Chrome provides the cached bytecode via
   `CachedData`. V8 deserializes instead of compiling (~10-50x faster).

### 3.2 NoCacheReason Enum (V8 `include/v8-script.h`)

```cpp
enum NoCacheReason {
  kNoCacheNoReason = 0,
  kNoCacheBecauseCachingDisabled,
  kNoCacheBecauseNoResource,
  kNoCacheBecauseInlineScript,
  kNoCacheBecauseModule,          // Worker top-level module scripts
  kNoCacheBecauseStreamingSource,
  kNoCacheBecauseScriptTooSmall,
  kNoCacheBecauseCacheTooCold,
  // ...
};
```

- `kNoCacheBecauseModule`: Used by Blink for worker top-level module scripts
  (the entry point passed to `new Worker(url, {type: 'module'})`). These are
  never cached. However, modules imported FROM the worker (static or dynamic)
  CAN be cached.
- `kNoCacheBecauseScriptTooSmall`: Modules under a threshold (~1 KB bytecode)
  are not worth caching.

### 3.3 Chrome GeneratedCodeCache

Chrome stores bytecode caches in a `SimpleBackend` disk cache at:
`~/.config/chromium/Default/Code Cache/js/` (Linux) or equivalent.

Key constraints:
- **Per-entry size limit**: Approximately 1/8 of total cache size. For a
  default 256 MB cache, max entry ≈ 32 MB. For smaller caches, the limit
  is proportionally lower.
- **Total cache size**: Configurable, typically 150-256 MB.
- **Write failures are silent**: When an entry exceeds the limit, the write
  is dropped without error. The trace shows `v8.produceModuleCache` firing
  successfully, but the storage layer doesn't persist the data.

### 3.4 Streaming Compilation

Worker module scripts have streaming disabled (`notStreamedReason: "already
disabled streaming"`). This means the browser must fully download the module
before parsing/compiling can begin. For a 57 MB chunk, this adds significant
download time before compilation even starts.

With WASM files emitted separately, `WebAssembly.compileStreaming()` handles
WASM compilation in parallel with the download — V8's Liftoff compiler can
begin before the full binary is available.

---

## 4. The Fix

### 4.1 Primary: Fix `assetsInlineLimit`

```typescript
// apps/ui/vite.config.ts
build: {
  assetsInlineLimit(file) {
    // Never inline SVGs (handled by sprite system)
    if (file.endsWith('.svg')) {
      return false;
    }
    // Use default threshold (4096 bytes) for everything else
    return undefined;
  },
}
```

### 4.2 Verified Results

Build output comparison (before → after):

| Chunk | Before | After | Reduction |
|---|---|---|---|
| `replicad.kernel` | 57 MB | **308 KB** | 185x |
| `esbuild.bundler` | 17 MB | **81 KB** | 212x |
| `replicad_with_exceptions` | 30 MB | **67 KB** | 447x |
| `replicad_single` | 25 MB | **67 KB** | 373x |

WASM files now emitted as separate assets:
- `replicad_single-*.wasm` — 19.9 MB
- `replicad_with_exceptions-*.wasm` — 23.3 MB
- `esbuild-*.wasm` — 13.5 MB
- `kcl_wasm_lib_bg-*.wasm` — 14.9 MB
- `manifold-*.wasm` — 476 KB

### 4.3 Verified Telemetry (after fix)

With the fix applied, `kernel.select` no longer appears in telemetry
(module loading is near-instant). The render is dominated by actual CAD
computation:

| Span | Before (broken) | After (fixed) |
|---|---|---|
| `kernel.select` | 936ms-1.15s | **not visible** (< 1ms) |
| `kernel.load-module` | 492-579ms | **not visible** |
| `replicad.run-main` | ~226ms | ~226ms (unchanged, actual work) |
| **Total render** | **1.26-1.56s** | **229ms** |

### 4.4 WASM Loading Path (after fix)

1. `replicad.kernel` (308 KB) → compiled with cached bytecode (< 1ms)
2. `resolveWasm()` → dynamic imports bindings chunk (67 KB, cached)
3. Bindings chunk → `new URL("*.wasm", import.meta.url)` → separate `.wasm` file
4. `compileWasmStreaming(wasmUrl)` → V8 streams and caches WASM compilation

---

## 5. How the Dep Injection Pattern Interacts

The ES module dependency injection pattern (`import(/* @vite-ignore */ moduleUrl)`)
is NOT the root cause. The dynamic import itself works correctly:

- `esbuild.bundler` is loaded via the same `import(/* @vite-ignore */ url)` pattern
  and is cached successfully (when its bytecode ≤ 20 MB).
- `kcl_wasm_lib` is loaded via static import on the main thread and is cached.

The dep injection pattern does introduce a **sequential waterfall**:
```
worker entry → framework init → dynamic import(kernel) → dynamic import(bindings) → WASM load
```

Each step requires: network fetch → parse → compile → execute. With proper
bytecode caching, the compile step is near-instant (2-5ms), making the
waterfall acceptable. Without caching (due to the WASM inlining bug), the
compile step dominates.

### Waterfall After Fix (verified)

| Step | Before (no cache) | After (cached) |
|---|---|---|
| `kernel.load-module` | 513ms | < 1ms (cached bytecode) |
| `replicad.resolve-bindings` | 92ms | < 1ms |
| `wasm.compile` | 255ms | < 1ms (cached after first load) |
| `wasm.emscripten-init` | 39ms | ~39ms |
| **Total overhead** | **~900ms** | **~40ms** |

The WASM compile benefits from V8's `NativeModuleCache` (verified in traces:
`CacheHit` for 14.9 MB OC binary). After the first render within a session,
WASM instantiation drops to ~1ms.

---

## 6. Trace Evidence Summary

### Data from `trace_multi-reload-tracing.json.gz` (5 page reloads)

**`replicad.kernel` cache lifecycle across reloads:**
```
Load 1: v8.compileModule     dur=232ms  cacheKind=ABSENT   ← cold compile
Load 2: v8.compileModule     dur=228ms  cacheKind=ABSENT   ← still cold
         v8.produceModuleCache  produced=59,663,120 bytes  ← cache produced...
Load 3: v8.compileModule     dur=221ms  cacheKind=ABSENT   ← ...but never stored!
```

**`esbuild.bundler` cache lifecycle (comparison):**
```
Load 1: v8.compileModule  dur=5ms  cacheKind=normal  consumed=18,052,912  ← hot
Load 2: v8.compileModule  dur=5ms  cacheKind=normal  consumed=18,052,912  ← hot
Load 3: v8.compileModule  dur=5ms  cacheKind=normal  consumed=18,052,912  ← hot
```

**Key contrast:**
- `esbuild.bundler` (17 MB JS → 18 MB cache): `cacheKind=normal` ✓
- `replicad.kernel` (57 MB JS → 59.6 MB cache): `cacheKind=ABSENT` ✗

The `cacheKind` field is **completely absent** from `replicad.kernel` compile
events — the bytecode cache infrastructure is never consulted because no cached
metadata exists for this resource (the prior write was silently dropped).

---

## 7. Additional Notes

### 7.1 Worker Entry Point Caching

Worker top-level module scripts (the URL passed to `new Worker(url, {type: 'module'})`)
are never bytecode-cached in Chrome. This is by design (`kNoCacheBecauseModule`).
In our architecture, the worker entry (`kernel-runtime-worker.ts`) is only 26 KB,
so this is not a significant concern.

### 7.2 Base64 Overhead

Base64 encoding adds 33% size overhead. A 19 MB WASM binary becomes a 25 MB base64
string literal. V8 must parse this 25 MB string on every compile — pure waste that
compounds the caching problem.

### 7.3 WASM Duplication

The `replicad.kernel` chunk contains BOTH WASM variants (single + exceptions) inlined,
even though only ONE is loaded at runtime (via a conditional dynamic import). After
the fix, this duplication is eliminated because the WASM files are separate assets
loaded on-demand.

### 7.4 esbuild-wasm

The `esbuild.bundler` chunk (17 MB) also had an inline WASM (17.2 MB from `esbuild-wasm`).
After fixing `assetsInlineLimit`, this chunk shrank to 81 KB. While `esbuild.bundler`
was already within Chrome's cache limit and working, the fix eliminates 17 MB of
unnecessary base64 parsing, reduces bandwidth, and improves cold load performance.

### 7.5 `new URL()` Pattern as the Inlining Trigger

The specific mechanism that caused Vite to inline WASM was the `new URL()` asset
reference pattern used by Emscripten-generated bindings. For example,
`replicad_single.js` contains:

```javascript
return new URL("replicad_single.wasm", import.meta.url).href
```

This pattern is Vite's standard way to reference static assets from JavaScript.
Vite intercepts these expressions at build time and applies `assetsInlineLimit` to
decide whether to inline or emit the referenced file. Since the buggy callback
returned `true` for `.wasm`, all WASM references through this pattern were inlined.

Other WASM-using libraries (`esbuild-wasm`, `manifold-3d`, `kcl-wasm-lib`, etc.)
use the same pattern and were similarly affected. The fix benefits all of them.

---

## 8. Residual WASM Init Cost (post-fix)

After fixing the `assetsInlineLimit` bug, a residual ~131ms WASM init cost
remains on each kernel startup (e.g., when switching between projects that
use the same kernel). Chrome tracing confirms all caches are working, but
the streaming pipeline has inherent overhead.

### 8.1 Trace-Verified Timeline (replicad_with_exceptions, 22.2 MB)

```
+  0.0ms  wasm.StartStreamingCompilation
+ 3-55ms  wasm.OnBytesReceived  (160 chunks, 22.2 MB from HTTP cache)
+ 58.5ms  wasm.FinishStreaming                dur=19.9ms
+ 70.1ms    └─ wasm.Deserialize               dur= 8.3ms  (disk cache → memory)
+ 72.0ms        └─ wasm.GetNativeModuleFromCache  dur=0.1ms  (process cache HIT)
+ 78.2ms  wasm.CompilationAfterDeserialization dur= 0.1ms  (schedule lazy funcs)
+ 80.2ms  wasm.SyncInstantiate                dur= 2.4ms
= 82.6ms  TOTAL (matches our 79ms wasm.compile span)
```

### 8.2 Cache Status: All Working

V8's NativeModuleCache (process-level, shared across isolates) shows cache
hits for all WASM modules:

| Module | Wire Bytes | Cache Lookup | Status |
|---|---|---|---|
| `replicad_with_exceptions` | 22.2 MB | 0.13ms | HIT |
| `esbuild` | 12.9 MB | 0.02ms | HIT |
| `kcl_wasm_lib` | 14.2 MB | 1.24ms | HIT |

### 8.3 Where the 131ms Goes

Despite cache hits, two costs are inherent per-worker-creation:

**`wasm.compile` (79ms)** — Streaming pipeline overhead:
- **55ms**: Fetching 22 MB through Chrome's Mojo data pipe, even from the
  HTTP disk cache. The data physically flows through the IPC pipeline;
  `compileStreaming(fetch(url))` cannot short-circuit before the fetch
  completes because the streaming compiler must validate the bytes match
  the cached module.
- **20ms**: `FinishStreaming` — includes deserializing cached native code
  from disk (8ms) and verifying against the NativeModuleCache (0.1ms).
- **2.4ms**: `SyncInstantiate` — memory allocation, table setup.

**`wasm.emscripten-init` (44ms, 37ms self-time)** — Emscripten runtime
bootstrap:
- **4-5ms**: `wasm.instantiate` — allocating linear memory, linking imports.
- **~37ms**: Emscripten runtime initialization — C++ global constructors
  for OpenCASCADE, virtual filesystem setup, `GrowMemory` calls. This is
  inherent to the library and executes every time a new Emscripten instance
  is created.

### 8.4 Why Worker Recreation Pays Full Cost

The kernel lifecycle currently terminates the Web Worker when switching
projects:

```
cad.machine exit → kernel.machine exit → destroyWorkers → kernelClient.terminate()
  → workerClient.cleanup() → workerClient.terminate() → transport.close()
    → worker.terminate()  ← destroys V8 isolate, all WASM state lost
```

When the next project opens, a new Worker is created. Even though V8's
process-level NativeModuleCache still holds the compiled module, the
streaming pipeline must run in full:

```
New Worker → load JS modules → fetch WASM → streaming pipeline → instantiate → emscripten init
               14ms (cached)     55ms (pipe)    20ms (finalize)    2.4ms          44ms (C++ ctors)
```

### 8.5 Optimization Strategies

**Strategy 1: Keep workers alive across project switches (saves ~123ms)**

Instead of `worker.terminate()` when switching between projects that use
the same kernel, send a reset command. The WASM module, Emscripten instance,
and OpenCASCADE state all stay alive. `KernelRuntimeWorker` already loads
kernels lazily and caches them; the missing piece is not destroying the
worker at the `kernel.machine` level.

Expected: `wasm.compile` (79ms) + `wasm.emscripten-init` (44ms) → **0ms**.

**Strategy 2: Transfer pre-compiled `WebAssembly.Module` via `postMessage`
(saves ~77ms when worker must restart)**

`WebAssembly.Module` is structured-cloneable. A long-lived coordinator
(main thread or a persistent worker) compiles the module once and holds a
reference. When a new kernel worker is created, the module is transferred
via `postMessage`, bypassing the entire fetch→stream→finalize pipeline.

V8 internally shares compiled code through the NativeModuleCache, so no
actual copy occurs — the receiving isolate gets a reference to the same
compiled native code. `wasm-loader.ts` would need a code path that accepts
a pre-compiled `WebAssembly.Module` instead of calling
`compileStreaming(fetch(url))`.

Expected: `wasm.compile` → **< 1ms**. `wasm.emscripten-init` still 44ms.

**Strategy 3: Pre-warm WASM at app startup (moves cost off critical path)**

Start `WebAssembly.compileStreaming(fetch(wasmUrl))` on the main thread
immediately at app load, before any project is opened. This populates both
the HTTP cache and V8's NativeModuleCache. The per-worker cost remains but
the first render is faster since all caches are warm.

### 8.6 V8 Isolate Boundary Summary

Each Web Worker has its own V8 isolate. WASM caching operates at two levels:

| Cache Level | Scope | Survives Worker Termination | Lookup Cost |
|---|---|---|---|
| **NativeModuleCache** | Renderer process | **Yes** (process-level) | 0.02-1.3ms |
| **GeneratedCodeCache** (disk) | Profile / origin | **Yes** (disk) | 3-11ms (deserialize) |
| **Compiled instance** (in-isolate) | Worker isolate | **No** | 0ms (already loaded) |

When a worker is terminated and recreated, the in-isolate compiled instance
is lost. V8 must deserialize from disk cache (3-11ms) or NativeModuleCache
(0.02-1.3ms) and re-run the streaming pipeline (55ms fetch + 20ms finalize).
The only way to avoid this is to keep the worker alive (Strategy 1) or
transfer the `WebAssembly.Module` directly (Strategy 2).

---

## 9. Conclusion

The ES module dependency injection pattern is **not** the performance problem.
The primary root cause was a Vite configuration bug that force-inlined large
WASM binaries into JavaScript chunks, exceeding V8's bytecode cache limits.
With the one-line fix to `assetsInlineLimit`, kernel startup drops from 1.3s
to ~229ms.

A secondary optimization opportunity exists: the residual ~131ms WASM init
cost (79ms compile + 44ms emscripten init) on kernel restarts can be
eliminated by keeping workers alive across project switches rather than
terminating and recreating them.
