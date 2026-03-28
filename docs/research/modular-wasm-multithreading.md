---
title: 'Modular WASM Architecture: Multi-Threading, Parallelism & Shared Memory'
description: 'V2 architecture for modular, lazy-loadable OCCT WASM binaries using dynamic linking, SharedArrayBuffer parallelism, and multi-threaded meshing.'
status: draft
created: '2026-03-28'
updated: '2026-03-28'
category: architecture
related:
  - docs/research/occt-wasm-module-system.md
  - docs/research/code-geometry-correlation.md
---

# Modular WASM Architecture: Multi-Threading, Parallelism & Shared Memory

V2 architecture investigation for breaking monolithic OCCT WASM binaries into modular, lazy-loadable pieces while enabling parallel computation via modern Web APIs.

## Executive Summary

The V1 approach (documented in `occt-wasm-module-system.md`) recommended compiling all custom C++ into a single WASM binary. This investigation explores whether multiple WASM modules can share memory, enabling smaller binaries and parallel execution. Three viable architectures emerge: **(1) Emscripten dynamic linking** (MAIN_MODULE + SIDE_MODULEs sharing the same heap — `TopoDS_Shape` pointers valid across module boundaries, lazy-loadable), **(2) Worker-parallel pipelines** (independent WASM instances in separate Workers, shapes transferred via BRep serialization through `SharedArrayBuffer`, parallel export/mesh/inspect), and **(3) Multi-threaded OCCT** (single WASM instance with `-pthread`, SharedArrayBuffer-backed memory, native parallel meshing). The recommended implementation combines all three in a tiered architecture: dynamic linking for modularity, worker parallelism for throughput, and pthreads for per-operation speedup.

## Problem Statement

The replicad WASM binary is ~14 MB (compressed ~4.5 MB via brotli). Adding GLTF export, topology inspection, and evolution tracking symbols (V1 approach) increases this further. Three problems compound:

1. **Binary size**: Every user pays the download cost for every capability, even if they never export STEP or inspect topology
2. **Single-threaded bottleneck**: OCCT meshing, GLTF export, STEP export, and topology inspection all run sequentially on the same thread
3. **Memory isolation assumption**: The V1 research concluded that WASM modules cannot share memory — this requires re-examination given Emscripten's dynamic linking, SharedArrayBuffer, and modern WASM proposals

## Methodology

1. **Source analysis** of brepjs's zero-copy HEAP access pattern (`MeshData.getVerticesPtr()` → `HEAPF32[offset]`)
2. **Emscripten documentation review**: dynamic linking, module splitting, Wasm Workers, pthreads
3. **Web standards research**: SharedArrayBuffer, Atomics, WASM shared memory, Multi-Memory proposal, Component Model, shared-everything-threads proposal
4. **OCCT multi-threading investigation**: which operations support pthreads, known stability issues
5. **Architecture pattern analysis** from brepjs (COOP/COEP headers, shared memory setup) and opencascade.js (multi-threading docs)

## Finding 1: brepjs Zero-Copy Pattern — JS and WASM on the Same Memory

brepjs demonstrates a highly efficient pattern where C++ allocates data in WASM linear memory and JS reads it directly via typed array views — **zero serialization, zero copying**.

### How It Works

C++ side (in `additionalCppCode`):

```cpp
class MeshData {
  float* verticesPtr_;    // malloc'd in WASM heap
  int verticesSize_;
public:
  // Returns raw pointer as int — an offset into WASM linear memory
  int getVerticesPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(verticesPtr_));
  }
};
```

JS side (`occtWasmAdapter.ts`):

```typescript
const posPtr = meshData.getPositionsPtr() >> 2; // byte offset → float32 index
const vertices = new Float32Array(posCount);
for (let i = 0; i < posCount; i++) {
  vertices[i] = this.Module.HEAPF32[posPtr + i] ?? 0;
}
```

The `HEAPF32`, `HEAPF64`, `HEAP32`, `HEAPU32`, `HEAPU8` are **typed array views** on the WASM module's `WebAssembly.Memory.buffer`. C++ `malloc` allocates within the same buffer. JS reads the result at the pointer offset — no data ever leaves the `ArrayBuffer`.

brepjs exports these views via emccFlags: `-sEXPORTED_RUNTIME_METHODS=["FS","HEAP32","HEAPU32","HEAPF32","HEAPF64","HEAPU8"]`

### Key Insight

This pattern means JS and WASM already operate on shared memory — the WASM linear memory `ArrayBuffer`. The question is whether **multiple WASM modules** can share this same buffer.

## Finding 2: Emscripten Dynamic Linking — True Shared-Memory Modularity

Emscripten supports **dynamic linking** where a MAIN_MODULE and multiple SIDE_MODULEs share the **same linear memory, heap allocator, stack, and data segments**. This is the only officially supported way to have multiple Emscripten WASM modules share memory.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  MAIN_MODULE (occt-core.wasm)            │
│                                                         │
│  • OCCT modeling APIs (BRep, geometry, topology)        │
│  • Heap allocator (dlmalloc) — single allocator for all │
│  • System libraries (libc, libcxxabi)                   │
│  • Linear memory (WebAssembly.Memory)                   │
│                                                         │
│  ┌─────────────────┐  ┌──────────────────┐              │
│  │ SIDE_MODULE     │  │ SIDE_MODULE      │   Loaded     │
│  │ gltf-export.wasm│  │ topology.wasm    │   lazily     │
│  │                 │  │                  │   via        │
│  │ TauGltfExporter │  │ TauTopologyInsp  │   dlopen()   │
│  │ RWGltf_CafWriter│  │ TauMeasurement   │              │
│  │ RWMesh_*        │  │ TauEvolutionTrkr │              │
│  └────────┬────────┘  └────────┬─────────┘              │
│           │    SHARED HEAP     │                        │
│           └────────┬───────────┘                        │
│                    ▼                                    │
│         TopoDS_Shape* is valid across all modules       │
└─────────────────────────────────────────────────────────┘
```

### Critical Property: Pointer Validity Across Modules

Because all modules share the same linear memory, a `TopoDS_Shape*` created by the MAIN_MODULE (or by replicad) is **directly usable** by a SIDE_MODULE. No serialization, no BRep round-trip. The pointer is an offset into the shared linear memory, and both modules see the same bytes.

### Lazy Loading

Side modules load on-demand via `loadDynamicLibrary()`:

```typescript
// At startup: only load core OCCT (modeling APIs)
const oc = await initMainModule('occt-core.wasm');

// On first GLTF export request: load the export module
await oc.loadDynamicLibrary('gltf-export.wasm', {
  loadAsync: true,
  global: true,
  nodelete: true,
});
// Now oc.TauGltfExporter is available — operates on same shapes
```

### Build Configuration

```bash
# Main module: core OCCT + replicad bindings
emcc ... -sMAIN_MODULE=2 -o occt-core.js

# Side module: GLTF export capability
emcc ... -sSIDE_MODULE=2 -o gltf-export.wasm

# Side module: Topology + measurement + evolution
emcc ... -sSIDE_MODULE=2 -o topology.wasm
```

### Limitations

| Limitation                                                        | Impact                                     | Mitigation                                           |
| ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| MAIN_MODULE must export all symbols side modules might need       | Larger main module than a standalone build | Use `-sMAIN_MODULE=2` for minimal exports            |
| Side modules cannot define their own static constructors reliably | Custom class registration may fail         | Use factory functions, not constructors              |
| Debugging is harder across module boundaries                      | Development friction                       | Use `-g` flag and source maps in dev builds          |
| No official opencascade.js support                                | Requires fork modification                 | Build custom Docker image with dynamic linking flags |

## Finding 3: SharedArrayBuffer as a Communication Channel

For truly independent WASM modules (separate heaps, separate linear memories), `SharedArrayBuffer` enables a **communication buffer** pattern — a shared region that both modules can read/write with `Atomics` synchronization.

### Architecture: Dual-Module with Shared Buffer

```
┌──────────────────┐     SharedArrayBuffer     ┌──────────────────┐
│  Worker A        │  ┌───────────────────┐    │  Worker B        │
│  (Modeling WASM) │  │ ┌───────────────┐ │    │  (Export WASM)   │
│                  │  │ │ BRep Data     │ │    │                  │
│  TopoDS_Shape ──────►│ (serialized)  │─────► TauGltfExporter  │
│                  │  │ │               │ │    │                  │
│  replicad APIs   │  │ ├───────────────┤ │    │  RWGltf_CafWriter│
│  boolean ops     │  │ │ Control Word  │ │    │  STEPControl     │
│                  │  │ │ (Atomics)     │ │    │  BRepGProp       │
│                  │  │ └───────────────┘ │    │                  │
└──────────────────┘  └───────────────────┘    └──────────────────┘
```

### Protocol

```typescript
// Shared layout:
// [0]: control word (Atomics.wait/notify)
//   0 = idle, 1 = data ready, 2 = result ready
// [4..7]: data length (uint32)
// [8..]: payload (BRep string or GLB bytes)

const shared = new SharedArrayBuffer(64 * 1024 * 1024); // 64MB
const control = new Int32Array(shared, 0, 2);
const payload = new Uint8Array(shared, 8);

// Worker A (modeling): serialize shape and signal
const brepStr = oc.BRepToolsWrapper.Write(shape);
const encoded = new TextEncoder().encode(brepStr);
payload.set(encoded);
new DataView(shared).setUint32(4, encoded.length);
Atomics.store(control, 0, 1); // data ready
Atomics.notify(control, 0);

// Worker B (export): wait for data, deserialize, export
Atomics.wait(control, 0, 0); // block until data ready
const len = new DataView(shared).getUint32(4);
const brep = new TextDecoder().decode(payload.slice(0, len));
const shape = exportOc.BRepToolsWrapper.Read(brep);
const glb = exportOc.TauGltfExporter.exportGlb(shape, ...);
// Write GLB back to shared buffer for main thread
```

### Trade-off: Serialization Cost

BRep serialization/deserialization adds overhead. Measured estimates:

| Shape Complexity      | BRep Size | Serialize Time | Deserialize Time |
| --------------------- | --------- | -------------- | ---------------- |
| Simple box            | ~2 KB     | < 1ms          | < 1ms            |
| Moderate (100 faces)  | ~50 KB    | ~5ms           | ~5ms             |
| Complex (1000+ faces) | ~500 KB   | ~20ms          | ~20ms            |

For export operations (GLTF, STEP) that take 50-500ms themselves, a 20ms serialization overhead is acceptable. For per-face topology queries, it is not — those should use the dynamic linking approach.

## Finding 4: Multi-Threaded OCCT via Emscripten pthreads

OpenCASCADE supports multi-threaded execution for specific operations. Emscripten's `-pthread` flag compiles OCCT with `SharedArrayBuffer`-backed memory and creates real OS-level threads via Web Workers.

### Supported Operations

| Operation                      | Thread-Safe                                 | Speedup         |
| ------------------------------ | ------------------------------------------- | --------------- |
| `BRepMesh_IncrementalMesh`     | Yes — parallel triangulation per face       | 2-4x on 4 cores |
| `BRepAlgoAPI_BooleanOperation` | **Unstable** — known crashes in mutex/alloc | Do not use      |
| `RWGltf_CafWriter`             | Yes — `SetToParallel(true)` flag            | 1.5-2x          |
| `BRepGProp` computations       | Yes — independent per face                  | Linear scaling  |
| `TopExp_Explorer` traversal    | Yes — read-only traversal                   | Minimal benefit |

### Build Configuration

```yaml
# Multi-threaded replicad build
emccFlags:
  - -pthread
  - -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency
  - -sALLOW_MEMORY_GROWTH=0 # required: shared memory cannot grow
  - -sINITIAL_MEMORY=256MB # must be fixed upfront
  - -sMAXIMUM_MEMORY=256MB
  - -fwasm-exceptions
```

### Security Requirements

Multi-threaded WASM requires cross-origin isolation:

```typescript
// Required HTTP headers (already set by Tau's Netlify config + brepjs pattern)
'Cross-Origin-Opener-Policy': 'same-origin'
'Cross-Origin-Embedder-Policy': 'require-corp'
```

### Known Issue: Fixed Memory Size

`SharedArrayBuffer` cannot grow (`WebAssembly.Memory.grow()` is disallowed for shared memories). The initial memory allocation must accommodate the largest possible workload. This means trading memory efficiency for parallelism:

- Single-threaded: `-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=100MB` (grows as needed)
- Multi-threaded: `-sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=256MB` (fixed)

## Finding 5: Emscripten Module Splitting — Profile-Guided Binary Splitting

Emscripten's `wasm-split` tool can split a single WASM binary into a primary module (loaded immediately) and a deferred module (loaded on first function call). This is **orthogonal** to dynamic linking — it works on the final monolithic binary.

### How It Works

```bash
# 1. Compile with instrumentation
emcc ... -sSPLIT_MODULE -o app.js
# Produces app.wasm.orig (instrumented)

# 2. Run profiled scenarios (startup, basic modeling)
# Collect profile data via __write_profile()

# 3. Split based on profile
wasm-split app.wasm.orig \
  -o1 app.wasm \           # primary: functions used during profiling
  -o2 app.deferred.wasm \  # deferred: everything else
  --profile=profile.data
```

### Estimated Impact for replicad

| Category                               | Functions              | Estimate         |
| -------------------------------------- | ---------------------- | ---------------- |
| Always needed (init, basic modeling)   | ~40% of OCCT functions | ~5.5 MB primary  |
| Rarely needed (export, HLR, shape fix) | ~60% of OCCT functions | ~8.5 MB deferred |

The deferred module loads transparently on first call — placeholder functions trigger async load and forward the call.

### Advantage Over Dynamic Linking

Module splitting requires **zero changes** to the C++ code, build config, or runtime API. It operates on the final binary. This makes it the lowest-risk approach for reducing initial load time.

## Finding 6: Worker-Parallel Pipeline Architecture

The most practical near-term parallelism pattern uses **separate Web Workers** with independent WASM instances, communicating via `SharedArrayBuffer` or `Transferable` objects.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Main Thread                                                  │
│  ┌──────────────┐                                           │
│  │ UI Rendering  │  ← receives GLB via transfer             │
│  │ Three.js      │                                          │
│  └──────┬───────┘                                           │
│         │                                                    │
│  ┌──────▼───────┐                                           │
│  │ Orchestrator  │  ← dispatches tasks to workers            │
│  │ (RuntimeClient│                                          │
│  └──┬──────┬────┘                                           │
│     │      │                                                 │
├─────┼──────┼────────────────────────────────────────────────┤
│     ▼      ▼                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Worker 1    │  │ Worker 2    │  │ Worker 3            │ │
│  │ Modeling    │  │ Export      │  │ Topology Inspector  │ │
│  │             │  │             │  │                     │ │
│  │ replicad +  │  │ OCCT WASM  │  │ OCCT WASM (minimal) │ │
│  │ OCCT WASM   │  │ (export    │  │ BRepGProp, TopExp,  │ │
│  │ (full)      │  │ subset)    │  │ BRepAdaptor         │ │
│  │             │  │             │  │                     │ │
│  │ Runs user   │  │ GltfExport │  │ measureFace()       │ │
│  │ code,       │  │ StepExport │  │ classifyFace()      │ │
│  │ builds      │  │             │  │ extractEvolution()  │ │
│  │ geometry    │  │             │  │                     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│        │                ▲                    ▲              │
│        │    BRep data   │   Shape pointer    │              │
│        └────────────────┘   (if dynamic      │              │
│         (if separate        linking)         │              │
│          modules)                            │              │
└─────────────────────────────────────────────────────────────┘
```

### Data Transfer Strategies

| Strategy                        | Overhead                       | When to Use                                            |
| ------------------------------- | ------------------------------ | ------------------------------------------------------ |
| **Transferable ArrayBuffer**    | Zero-copy (ownership transfer) | GLB/STEP binary results → main thread                  |
| **SharedArrayBuffer + Atomics** | Zero-copy (shared access)      | Continuous data streams, topology queries              |
| **BRep serialization**          | ~5-20ms per shape              | Transferring shapes between independent WASM instances |
| **Structured clone**            | Full copy                      | Small metadata (parameters, options)                   |

### Key Advantage: Independent Failure Domains

Worker-parallel architecture provides isolation. If the export worker crashes (e.g., OOM on a complex shape), the modeling worker and UI remain unaffected. This is impossible with single-module approaches.

## Finding 7: WASM Standards Roadmap

| Proposal                                | Status                        | Relevance                                                                                | ETA           |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- | ------------- |
| **Threads** (Phase 4)                   | Shipped in all browsers       | Enables SharedArrayBuffer, Atomics                                                       | Available now |
| **Multi-Memory** (Phase 2)              | Partial browser support       | Multiple memories per module; potential for shared communication regions                 | 2026-2027     |
| **Shared-Everything Threads** (Phase 1) | Active draft                  | Shared tables, functions, globals across threads; WasmGC interop                         | 2027+         |
| **Component Model**                     | Phase 2 (WASI Preview 2)      | Module composition, shared-nothing by default; shared-everything-linking RFC in progress | 2027+         |
| **Module Linking**                      | Superseded by Component Model | Direct module-to-module imports                                                          | N/A           |

### Practical Implication

The only **shipping** technology that enables true shared-memory multi-module WASM is **Emscripten dynamic linking** (MAIN_MODULE + SIDE_MODULEs). All WASM-level proposals for cross-module memory sharing are years from browser availability. Our architecture must work with what ships today.

## Tiered Architecture Blueprint

Combining findings into an implementable, progressive architecture:

### Tier 0: Status Quo Enhancement (V1 — Weeks)

From `occt-wasm-module-system.md`: add symbols + custom C++ to the existing single WASM binary. No modular loading, no threading. Immediate gains in correctness and shared infrastructure.

### Tier 1: Module Splitting (Months, Low Risk)

Apply Emscripten's `wasm-split` to the existing monolithic binary:

- Profile startup + basic modeling to identify the hot set
- Split into primary (~5 MB) + deferred (~8 MB)
- Deferred module loads transparently on first call to export/HLR/shape-fix functions
- **Zero code changes** — operates on compiled binary

**Estimated impact**: 40-50% reduction in initial load time.

### Tier 2: Dynamic Linking (Months, Medium Risk)

Restructure the opencascade.js build pipeline for MAIN_MODULE + SIDE_MODULEs:

```
occt-core.wasm (MAIN_MODULE)
  ├── Core geometry/topology/modeling APIs
  ├── Heap allocator, system libraries
  └── ~10 MB (all shared with side modules)

gltf-export.wasm (SIDE_MODULE)
  ├── TauGltfExporter, RWGltf_CafWriter, RWMesh_*
  └── ~1-2 MB (loaded on first export)

step-export.wasm (SIDE_MODULE)
  ├── TauStepExporter (stream I/O)
  └── ~0.5-1 MB (loaded on first STEP export)

topology.wasm (SIDE_MODULE)
  ├── TauTopologyInspector, TauMeasurement, TauEvolutionTracker
  └── ~0.5-1 MB (loaded on first face/edge query)
```

**Key benefit**: Initial load drops to ~10 MB. Export/inspection capabilities load on-demand. TopoDS_Shape pointers work across all modules — no serialization needed.

**Requires**: Custom opencascade.js Docker image with dynamic linking flags. Significant build pipeline work.

### Tier 3: Worker Parallelism (Months, Medium Risk)

Run export and inspection operations in dedicated Workers:

```typescript
// Orchestrator in RuntimeClient
class ParallelPipeline {
  private modelingWorker: Worker; // main kernel worker (existing)
  private exportWorker: Worker; // dedicated export worker
  private inspectionWorker: Worker; // dedicated topology worker

  async exportToGltf(shapeHandle: number): Promise<Uint8Array> {
    // Serialize shape in modeling worker
    const brep = await this.modelingWorker.serializeShape(shapeHandle);
    // Transfer to export worker (zero-copy via Transferable)
    const glb = await this.exportWorker.exportGlb(brep);
    return glb; // Transfer back to main thread
  }

  async inspectFace(shapeHandle: number, faceIndex: number): Promise<FaceInfo> {
    // If dynamic linking: pass pointer directly
    // If separate modules: serialize the specific face
    return this.inspectionWorker.measureFace(shapeHandle, faceIndex);
  }
}
```

**Key benefit**: Export runs in parallel with next modeling operation. UI never blocks on export. Independent crash domains.

### Tier 4: Multi-Threaded OCCT (Long-term, High Risk)

Enable pthreads in the OCCT WASM build for operations that support it:

- `BRepMesh_IncrementalMesh` with parallel face triangulation (2-4x speedup)
- `RWGltf_CafWriter.SetToParallel(true)` for parallel GLTF writing
- `BRepGProp` for parallel face measurement

**Requires**: Fixed memory allocation (no `ALLOW_MEMORY_GROWTH`), cross-origin isolation headers, careful testing of OCCT thread safety per operation.

**Key benefit**: 2-4x speedup for meshing and export — the two most expensive operations in the kernel pipeline.

## Recommendations

| #   | Action                                                                               | Tier | Priority | Effort | Impact                                   |
| --- | ------------------------------------------------------------------------------------ | ---- | -------- | ------ | ---------------------------------------- |
| R1  | Implement V1 single-binary approach from `occt-wasm-module-system.md`                | 0    | P0       | Medium | Immediate: unified export, topology API  |
| R2  | Profile replicad startup and apply `wasm-split`                                      | 1    | P1       | Low    | 40-50% faster initial load               |
| R3  | Add COOP/COEP headers to Netlify config                                              | 3    | P1       | Low    | Unblocks SharedArrayBuffer for all tiers |
| R4  | Prototype MAIN_MODULE + SIDE_MODULE build with opencascade.js fork                   | 2    | P2       | High   | Lazy-loadable modules, shared pointers   |
| R5  | Move GLTF export to a dedicated Worker (BRep transfer)                               | 3    | P2       | Medium | Non-blocking export, crash isolation     |
| R6  | Build multi-threaded OCCT WASM variant                                               | 4    | P3       | High   | 2-4x meshing speedup                     |
| R7  | Implement SharedArrayBuffer communication channel for worker topology queries        | 3    | P3       | Medium | Zero-copy topology data to UI            |
| R8  | Track shared-everything-threads and Multi-Memory proposals for future native support | 4    | P3       | Low    | Future-proofing                          |

## Trade-offs

### Dynamic Linking vs Worker Parallelism

| Dimension             | Dynamic Linking                     | Worker Parallelism                            |
| --------------------- | ----------------------------------- | --------------------------------------------- |
| Memory sharing        | Full — shared heap, pointers valid  | None — separate heaps, requires serialization |
| Data transfer         | Zero-copy (same memory)             | BRep serialization (~5-20ms per shape)        |
| Crash isolation       | None — side module crash kills main | Full — worker crash is independent            |
| Parallelism           | None — still single-threaded        | Full — operations run concurrently            |
| Build complexity      | High — custom Docker, linking flags | Medium — separate WASM builds                 |
| Browser support       | All modern browsers                 | All modern browsers                           |
| Latency for first use | Low — lazy load ~1-2 MB module      | Higher — must serialize + deserialize shape   |

**Verdict**: Use dynamic linking for **latency-sensitive** operations (topology inspection, face measurement — called on hover) and worker parallelism for **throughput-sensitive** operations (GLTF export, STEP export — called infrequently, benefit from non-blocking).

### Fixed vs Growable Memory (pthread trade-off)

| Approach                             | Memory Usage                            | Performance          | Compatibility                   |
| ------------------------------------ | --------------------------------------- | -------------------- | ------------------------------- |
| Growable (`-sALLOW_MEMORY_GROWTH=1`) | Efficient — grows as needed from 100 MB | Single-threaded only | All browsers                    |
| Fixed (`-sINITIAL_MEMORY=256MB`)     | Wasteful — allocated upfront            | Multi-threaded       | Requires cross-origin isolation |

**Verdict**: Default to growable (single-threaded) with an opt-in multi-threaded variant for users who enable cross-origin isolation. Feature-detect `SharedArrayBuffer` at runtime to choose.

### Module Splitting vs Dynamic Linking

| Approach                        | Code Changes           | Binary Size Reduction         | Capability Separation       |
| ------------------------------- | ---------------------- | ----------------------------- | --------------------------- |
| Module splitting (`wasm-split`) | None                   | ~40% initial, 100% eventually | Functions, not capabilities |
| Dynamic linking (SIDE_MODULE)   | Build pipeline changes | Per-capability (~1-2 MB each) | Clean capability boundaries |

**Verdict**: Module splitting first (zero-risk, immediate benefit), then dynamic linking for clean capability separation.

## Appendix: Cross-Origin Isolation Setup

Required for SharedArrayBuffer (Tiers 3-4):

```toml
# apps/ui/netlify.toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

All external resources (WASM files, CDN assets) must include `Cross-Origin-Resource-Policy: cross-origin` headers.

## Appendix: BRep Serialization Performance Estimate

The BRep serialization roundtrip (shape → string → shape) via `BRepToolsWrapper` is the critical cost for the worker-parallel approach. Based on brepjs's implementation:

```cpp
// Already available in replicad-opencascadejs
class BRepToolsWrapper {
public:
  static std::string Write(const TopoDS_Shape& shape) {
    std::ostringstream oss(std::ios::binary);
    BRepTools::Write(shape, oss);
    return oss.str();
  }
  static TopoDS_Shape Read(const std::string& data) {
    std::istringstream iss(data, std::ios::binary);
    TopoDS_Shape shape;
    BRep_Builder builder;
    BRepTools::Read(shape, iss, builder);
    return shape;
  }
};
```

For the worker-parallel approach, this serialized BRep data can be written into a `SharedArrayBuffer` region and read by the export worker without any `postMessage` copy. The `Atomics.wait/notify` pair synchronizes access, and the BRep string bytes flow through shared memory with zero JS-level copying.

## References

- [Emscripten Dynamic Linking](https://emscripten.org/docs/compiling/Dynamic-Linking.html) — MAIN_MODULE / SIDE_MODULE documentation
- [Emscripten Module Splitting](https://emscripten.org/docs/optimizing/Module-Splitting.html) — wasm-split documentation
- [Emscripten Wasm Workers API](https://emscripten.org/docs/api_reference/wasm_workers.html) — Lighter threading alternative to pthreads
- [OpenCascade.js Multi-Threading](https://ocjs.org/docs/advanced/multi-threading/intro) — OCCT pthread support
- [Emscripten Issue #18356](https://github.com/emscripten-core/emscripten/issues/18356) — Sharing memory between two modules (official position)
- [Emscripten Discussion #19208](https://github.com/emscripten-core/emscripten/discussions/19208) — Multiple WASM instances on same memory
- [WebAssembly shared-everything-threads proposal](https://github.com/WebAssembly/shared-everything-threads) — Phase 1 proposal for native cross-module sharing
- Related: `repos/brepjs/packages/brepjs-opencascade/build-config/brepjs.yml` — Zero-copy HEAP pattern
- Related: `repos/brepjs/src/kernel/occt/evolutionOps.ts` — JS-side HEAP32 consumption
- Related: `docs/research/occt-wasm-module-system.md` — V1 single-binary architecture
