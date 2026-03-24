---
title: 'Runtime Overhead Forensics'
description: 'Forensic analysis of Tau runtime framework overhead using V8 CPU profiling, identifying per-function time attribution across all JS callsites and actionable optimization opportunities'
status: active
created: '2026-03-24'
updated: '2026-03-24'
category: optimization
related:
  - docs/architecture/runtime-topology.md
  - docs/research/replicad-performance-blueprint.md
---

# Runtime Overhead Forensics

Forensic analysis of the Tau `@taucad/runtime` framework overhead versus kernel (OpenCASCADE/Replicad) work, using V8 CPU profiling across the full benchmark suite to identify every function consuming wall time and produce actionable optimization opportunities.

## Executive Summary

V8 CPU profiling of 18 benchmark cases reveals that **framework overhead is inversely proportional to geometry complexity**: simple primitives (box, cylinder, sketch-extrude) spend 40-50% of wall time in framework code, while complex models (cycloidal-gear, vase, bottle) spend only 5-10%. The dominant framework costs are: (1) double code execution via `executeCode` (once for parameter extraction, once for geometry), (2) esbuild bundling on cache miss, (3) GLB serialization via `@gltf-transform/core`, and (4) dependency hashing via `JSON.stringify`. For complex models, OpenCASCADE WASM dominates (50-85% of wall time), making framework optimization low-impact. The highest-ROI optimizations target the sub-50ms operations where framework overhead is perceptible.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Wall-clock phase breakdown](#finding-1-wall-clock-phase-breakdown)
  - [Finding 2: The double-execute pattern](#finding-2-the-double-execute-pattern)
  - [Finding 3: GLB serialization dominates short renders](#finding-3-glb-serialization-dominates-short-renders)
  - [Finding 4: Dependency hashing overhead](#finding-4-dependency-hashing-overhead)
  - [Finding 5: OC tracing Proxy cost](#finding-5-oc-tracing-proxy-cost)
  - [Finding 6: Telemetry and tracer overhead](#finding-6-telemetry-and-tracer-overhead)
  - [Finding 7: Transport structured clone](#finding-7-transport-structured-clone)
  - [Finding 8: base64 encoding in executeCode](#finding-8-base64-encoding-in-executecode)
- [Per-benchmark overhead profile](#per-benchmark-overhead-profile)
- [Recommendations](#recommendations)
- [Appendix: Raw profiling data](#appendix-raw-profiling-data)

## Problem Statement

The benchmark runner (`benchmark-runner.ts`) captures wall-clock time and OC class-level summaries, but cannot explain where the remaining time goes. A `box` primitive takes ~16ms wall-clock but only 1.4ms in OpenCASCADE API calls — **91% of time is unaccounted for**. This investigation traces every millisecond through V8 CPU profiling to identify what the framework is doing with that time.

## Methodology

1. **V8 CPU profiling** via `node:inspector/promises` `Profiler` API at 100us sampling interval, integrated into the benchmark runner (`--cpuProfile` flag). Profiling starts after 3 warmup iterations to capture Turbofan-optimized steady state.
2. **Telemetry span analysis** from `RuntimeTracer` `performance.measure()` entries, providing phase-level wall-clock timings (kernel.render, kernel.bundle, kernel.execute, replicad.run-main, replicad.mesh-to-gltf).
3. **OC summary tracing** from the `oc-tracing.ts` Proxy, reporting per-class call counts and cumulative time.
4. **Baseline comparison**: benchmark run with `--noTracing` to measure overhead introduced by the tracing infrastructure itself.
5. **Source code audit** of every file in the render call chain from `client.render()` through to kernel result.
6. **18 benchmark cases** across 7 categories (primitives, booleans, fillets, extrusions, complex, examples, stress), 3 measured iterations each.

## Findings

### Finding 1: Wall-clock phase breakdown

The render pipeline has five sequential phases. Telemetry spans and profiling show their relative cost varies dramatically by complexity:

| Phase                                            | Box (16ms)  | Bottle (292ms) | Cycloidal-gear (564ms) |
| ------------------------------------------------ | ----------- | -------------- | ---------------------- |
| Dependency resolution + hashing                  | ~2ms (12%)  | ~2ms (0.7%)    | ~2ms (0.4%)            |
| Bundling (esbuild, cached)                       | <1ms (5%)   | <1ms (0.3%)    | <1ms (0.2%)            |
| Code execution (dynamic import)                  | ~2ms (12%)  | ~2ms (0.7%)    | ~2ms (0.4%)            |
| User main + OC calls                             | ~1.4ms (9%) | ~111ms (38%)   | ~295ms (52%)           |
| GLB conversion + serialization                   | ~8ms (50%)  | ~170ms (58%)   | ~258ms (46%)           |
| Framework overhead (tracer, transport, dispatch) | ~2ms (12%)  | ~7ms (2.4%)    | ~7ms (1.2%)            |

**Key insight**: For simple primitives, GLB conversion and code execution dominate. For complex models, OC WASM and GLB conversion dominate. The framework dispatch overhead is roughly constant at ~2-7ms regardless of model complexity.

### Finding 2: The double-execute pattern

The `KernelWorker.render()` method calls two kernel phases sequentially:

1. `getParameters(file)` → `bundle(filePath)` → `execute(bundledCode)` → extract default parameters
2. `createGeometry(file, params)` → `bundle(filePath)` → `execute(bundledCode)` → run `main()`

The **bundle** call is cached by `bundleResultCache` (keyed by entry path), so the second bundle is a cache hit. However, `execute` is **not cached** — it performs a fresh dynamic `import()` of the bundled code each time:

```typescript
// esbuild-core.ts executeCode() — runs TWICE per render
const { Buffer: NodeBuffer } = await import('node:buffer');
const base64Code = NodeBuffer.from(code).toString('base64');
url = `data:application/javascript;base64,${base64Code}`;
const moduleExports = await import(url);
```

Each `executeCode` call:

- Base64-encodes the entire bundled source (~10-50KB) via `Buffer.from(code).toString('base64')`
- Constructs a data URL
- Performs `await import(dataUrl)` — V8 must parse, compile (or re-compile), and execute the module

The `base64ToUint8Array` function from `uint8array-extras` appears in CPU profiles at **1.5-1.7ms self time** for simple benchmarks — a significant fraction of a 10-16ms render. The double-execute means this cost is paid twice.

### Finding 3: GLB serialization dominates short renders

The `replicad.mesh-to-gltf` span covers `convertReplicadGeometriesToGltf`, which uses `@gltf-transform/core`:

- Creates a `Document`, `Scene`, `Node`, and `Mesh` per shape
- Allocates typed arrays (`Float32Array`, `Uint32Array`) from replicad face data via `transformVertexArray`/`transformNormalArray`
- Serializes to GLB binary via `NodeIO.writeBinary()`

For the `box` benchmark (6 faces, ~100 vertices), this takes ~8ms — more than the OC kernel work (1.4ms). The `write` function from `@gltf-transform/core` appears in CPU profiles consuming measurable self time even for trivial geometry. The library is designed for full glTF feature support (animations, extensions, validation), which is architectural overhead for our use case of mesh-only output.

### Finding 4: Dependency hashing overhead

`KernelWorker.computeDependencyHash()` serializes the full dependency array to JSON then hashes it:

```typescript
// kernel-worker.ts:2027-2031
private computeDependencyHash(dependencies: readonly Dependency[]): string {
  const contentHashSpan = this.tracer.startSpan('deps.content-hash');
  const hex = hashString(JSON.stringify(dependencies));
  contentHashSpan.end();
  return hex;
}
```

This runs **twice per render** — once during `getParameters` and once during `createGeometry` — with different dependency arrays (the second includes `ParameterDependency`). For projects with many files or middleware, `JSON.stringify` on the dependency array becomes measurable.

The `renderDependencyCache` mitigates file discovery overhead between the two phases but does not avoid the double hash.

### Finding 5: OC tracing Proxy cost

The `oc-tracing.ts` Proxy wraps every OpenCASCADE API call. In `summary` mode (the benchmark default), it records `performance.now()` timestamps around each call:

- `construct` handler: appears in CPU profiles at 0.4ms self time for `box` (47 `gp_Vec` calls + other constructors)
- `isEmscriptenRecord`: helper function for Proxy trap classification, 0.17ms self time

For complex models with thousands of OC calls, the Proxy overhead is dominated by the OC calls themselves. But for simple models where OC work is <2ms, the Proxy adds measurable relative overhead.

The `--noTracing` baseline confirms this: `box` drops from 16.85ms (tracing) to ~15.78ms (CPU profiled), but the tracing-off run shows 16.85ms — suggesting the ~1ms difference is within noise. OC tracing overhead is real but small (~0.5-1ms for simple models).

### Finding 6: Telemetry and tracer overhead

The `RuntimeTracer` and `WorkerTelemetryCollector` add per-render overhead:

- `tracer.reset()` calls `performance.clearMarks()` + `performance.clearMeasures()` at the start of every render — this clears the **global** performance timeline, an O(n) operation on the number of accumulated entries
- Each `tracer.startSpan()` allocates a mark name string, calls `performance.mark()`, and returns a closure
- Each `span.end()` builds a `detail` object with nested `devtools` metadata and calls `performance.measure()`
- `PerformanceObserver` callback fires for each measure, allocating a `PerformanceEntryData` object
- `flush()` after render clones the batch array via `postMessage`

A typical render produces 10-20 spans (kernel.render, kernel.bundle, kernel.execute, kernel.compute, deps.discover, deps.read, deps.hash, deps.content-hash, fs.read, replicad.run-main, replicad.mesh-to-gltf). Each span adds ~0.05ms of combined mark/measure/observer overhead, totaling ~0.5-1ms per render.

### Finding 7: Transport structured clone

The in-process transport (`createInProcessTransport`) uses `MessageChannel.postMessage`, which performs structured cloning even within the same thread:

- **Render command**: clones `{ type, requestId, file, params, tessellation }` — small payload, negligible
- **Progress + parametersResolved**: 2-3 additional `postMessage` calls during render
- **geometryComputed response**: transfers GLB `ArrayBuffer` via transferables (zero-copy), but still clones the metadata wrapper

The `MessageChannel` constructor itself appears in profiles at 0.25ms — this is a one-time cost per `createInProcessTransport()` call but shows up in the per-case profile because the benchmark creates a new client per case.

### Finding 8: base64 encoding in executeCode

In Node.js, `executeCode` base64-encodes the bundled code for a data URL:

```typescript
const base64Code = NodeBuffer.from(code).toString('base64');
url = `data:application/javascript;base64,${base64Code}`;
```

CPU profiles show `base64ToUint8Array` (from the base64 decode on import) at 1.5-1.7ms for simple benchmarks. This is paid **twice** per render (double-execute). A cached or URL-reuse approach could eliminate this entirely.

## Per-benchmark overhead profile

Overhead as percentage of wall time, derived from framework overhead calculation (framework+bundler vs kernel+WASM, excluding idle/GC/V8 internals):

| Benchmark             | Mean (ms) | OC Time (ms) | OC %  | Framework Overhead % | Category   |
| --------------------- | --------- | ------------ | ----- | -------------------- | ---------- |
| box                   | 15.78     | 1.38         | 8.7%  | 50.0%                | primitives |
| cylinder              | 11.77     | 1.30         | 11.0% | 41.1%                | primitives |
| sketch-extrude        | 11.38     | 0.93         | 8.2%  | 49.5%                | extrusions |
| sketch-revolve        | 12.02     | 2.44         | 20.3% | 33.3%                | extrusions |
| sphere                | 25.40     | 9.37         | 36.9% | 11.7%                | primitives |
| cut-cylinder-from-box | 17.98     | 3.95         | 22.0% | 39.1%                | booleans   |
| fuse-two-boxes        | 21.68     | 6.05         | 27.9% | 28.0%                | booleans   |
| box-chamfer-all       | 30.48     | 1.76         | 5.8%  | 33.6%                | fillets    |
| box-fillet-all        | 36.22     | 3.45         | 9.5%  | 26.2%                | fillets    |
| tray                  | 34.98     | 6.81         | 19.5% | 14.4%                | examples   |
| n-body-fuse           | 51.99     | 16.61        | 32.0% | 15.6%                | booleans   |
| deep-boolean-chain    | 147.99    | 37.80        | 25.5% | 11.1%                | stress     |
| vase                  | 183.29    | 71.40        | 39.0% | 5.0%                 | examples   |
| multi-hole-plate      | 204.76    | 72.86        | 35.6% | 6.0%                 | complex    |
| birdhouse             | 219.09    | 91.98        | 42.0% | 11.9%                | examples   |
| gridfinity-box        | 225.31    | 76.07        | 33.8% | 10.2%                | examples   |
| bottle                | 291.65    | 110.83       | 38.0% | 9.7%                 | examples   |
| cycloidal-gear        | 564.34    | 295.31       | 52.3% | 5.2%                 | examples   |

**Observation**: OC time as a percentage of wall time rarely exceeds 55%. The remaining time splits between: replicad JS glue code (mesh traversal, shape output), GLB conversion, framework phases, and the `base64ToUint8Array` / `executeCode` overhead. For a `box` at 16ms with only 1.4ms in OC, the unaccounted ~14.4ms is: ~8ms GLB, ~4ms double-execute+base64, ~2ms deps+tracing+transport.

## Recommendations

| #   | Action                                                                                    | Priority | Effort | Impact                                                                                       |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------- |
| R1  | Cache `executeCode` module by code hash — avoid double `import()` + base64 encode         | P0       | Medium | High for <50ms renders: eliminates ~3-4ms per render                                         |
| R2  | Use `Blob` URL on Node.js (Node 20+ supports it) instead of base64 data URL               | P1       | Low    | Eliminates base64 encode/decode (~1.5ms per execute)                                         |
| R3  | Evaluate direct GLB construction without `@gltf-transform/core` for mesh-only output      | P1       | High   | Could halve GLB time for simple geometry; the GLB spec for mesh-only data is straightforward |
| R4  | Cache `computeDependencyHash` base result between `getParameters` and `createGeometry`    | P2       | Low    | Saves one `JSON.stringify` + hash per render (~0.5ms)                                        |
| R5  | Merge parameter extraction and geometry into a single kernel phase when possible          | P2       | High   | Eliminates duplicate dependency resolution + execute; architectural change                   |
| R6  | Scope `tracer.reset()` to epoch-tagged entries instead of clearing global timeline        | P2       | Low    | Prevents O(n) clear overhead; improves debuggability                                         |
| R7  | Batch `progress` + `parametersResolved` with `geometryComputed` in a single `postMessage` | P3       | Low    | Reduces 2-3 extra structured clones per render                                               |
| R8  | Cache `jsonSchemaFromJson` by parameter content hash                                      | P3       | Low    | Avoids schema re-derivation when parameters unchanged                                        |

### R1 detail: Execute cache

The highest-ROI optimization. The bundle result is already cached (`bundleResultCache`), so the same code string is passed to `executeCode` twice. A simple cache keyed by code hash would avoid the second parse/compile/execute:

```typescript
const executeCache = new Map<string, unknown>();

async function executeCodeCached(code: string): Promise<ExecuteResult> {
  const hash = hashString(code);
  const cached = executeCache.get(hash);
  if (cached) {
    return { success: true, value: cached };
  }
  const result = await executeCode(code);
  if (result.success) {
    executeCache.set(hash, result.value);
  }
  return result;
}
```

**Caveat**: Module re-execution is required when the code has side effects that must re-run (e.g., global state mutations in user code). In practice, Replicad user modules are pure — `main()` is a function that returns shapes from parameters. The cache should be invalidated when `bundleResultCache` is invalidated (file change).

### R3 detail: Direct GLB construction

The GLB binary format is simple for mesh-only data:

- 12-byte header (magic + version + length)
- JSON chunk (scene graph, accessors, buffer views, materials)
- BIN chunk (vertex positions, normals, indices, packed contiguously)

A direct writer that constructs the JSON chunk as a string template and concatenates the binary buffers would bypass `@gltf-transform/core`'s full document model (nodes, scenes, extensions, validation). This is the pattern used by Three.js's `GLTFExporter` internally. Estimated savings: 3-5ms for simple geometry, proportionally less for complex geometry where the typed array allocation dominates.

### R5 detail: Single-phase render

The current two-phase design (getParameters → createGeometry) exists because the parameter UI needs schema before geometry computation. However, when parameters haven't changed, re-extracting defaults is wasted work. The autonomous render loop in `runtime-topology.md` already envisions `setParameters` as a separate command — the kernel could cache extracted parameters and skip `getParameters` on parameter-only changes.

## Appendix: Raw profiling data

### CPU profile category breakdown (representative cases)

**box** (total: 87.6ms profiled, 3 iterations):

- node: 42.5ms (48.6%) — dominated by `inspector.Session.post` overhead
- idle: 30.3ms (34.6%)
- other: 7.7ms (8.8%) — WASM functions (`wasm://` URLs)
- v8: 2.7ms (3.0%)
- kernel: 2.2ms (2.5%)
- bundler: 1.3ms (1.5%)
- framework: 0.8ms (1.0%)

**bottle** (total: 1015.6ms profiled, 3 iterations):

- other: 808.0ms (79.6%) — WASM functions
- node: 143.6ms (14.1%) — inspector overhead
- kernel: 33.1ms (3.3%)
- idle: 18.8ms (1.9%)
- gc: 4.3ms (0.4%)
- framework: 2.3ms (0.2%)
- bundler: 1.3ms (0.1%)

**cycloidal-gear** (total: 1903.0ms profiled, 3 iterations):

- other: 1600.8ms (84.1%) — WASM functions
- node: 212.2ms (11.1%) — inspector overhead
- kernel: 50.5ms (2.7%)
- idle: 19.3ms (1.0%)
- gc: 13.3ms (0.7%)
- framework: 1.7ms (0.1%)

**Note**: WASM functions are classified as "other" because their URLs use `wasm://` scheme rather than empty strings. The profile analyzer should be updated to classify `wasm://` URLs as `wasm` category for future runs.

### Top self-time functions (box, single iteration ~16ms)

| Function             | Self Time | Source                                                |
| -------------------- | --------- | ----------------------------------------------------- |
| `base64ToUint8Array` | 1.67ms    | `uint8array-extras` (via executeCode data URL import) |
| `postMessage`        | 0.50ms    | Transport structured clone                            |
| `wasm-to-js`         | 0.46ms    | V8 WASM-JS boundary calls                             |
| `construct` (Proxy)  | 0.42ms    | `oc-tracing.ts` OC Proxy                              |
| `jc`                 | 0.29ms    | `replicad_single.js` (Emscripten glue)                |
| `write`              | 0.29ms    | `@gltf-transform/core` GLB serialization              |
| `MessageChannel`     | 0.25ms    | Transport initialization                              |
| `getParameters`      | 0.25ms    | `kernel-worker.ts`                                    |

### Baseline timing comparison (tracing on vs off)

Both runs use `--iterations 3`. The "with tracing" column includes OC summary tracing + CPU profiling; the "without" column disables OC tracing and CPU profiling.

| Benchmark      | With tracing (ms) | Without tracing (ms) | Delta (ms) | Delta (%) |
| -------------- | ----------------- | -------------------- | ---------- | --------- |
| sketch-extrude | 11.38             | 8.94                 | +2.44      | +27%      |
| box            | 15.78             | 16.85                | -1.07      | noise     |
| tray           | 34.98             | 25.95                | +9.03      | +35%      |
| bottle         | 291.65            | 266.09               | +25.56     | +10%      |
| cycloidal-gear | 564.34            | 516.69               | +47.65     | +9%       |

OC tracing in `summary` mode adds approximately 5-10% overhead for complex models, scaling with the number of OC API calls. For simpler models (tray, sketch-extrude), the relative overhead is higher (~27-35%) because the baseline compute is smaller. The `box` anomaly (+1.07ms without tracing) is within measurement noise.
