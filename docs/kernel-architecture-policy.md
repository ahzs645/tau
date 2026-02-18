# Kernel Architecture Policy

Internal reference for the CAD kernel worker architecture: from editor to geometry computation.

## Architecture Overview

```
Route (builds_.$id)
  └─ BuildMachine (1 per build)
       ├─ FileManagerMachine (1 per build, shared)
       ├─ EditorMachine (1 per build, UI state)
       ├─ ViewGraphics: Map<viewId, GraphicsMachine>
       │    └─ GraphicsMachine (1 per viewer panel, WebGL rendering)
       └─ CompilationUnits: Map<entryFile, CadMachine>
            └─ CadMachine (1 per entry file, headless computation)
                 └─ KernelMachine (1 per CadMachine)
                      └─ Workers: replicad, openscad, zoo, tau, jscad
                           (5 Web Worker threads per KernelMachine)
```

### Machine Multiplicity

| Component | Per-build count | Per-viewer-panel count | Notes |
|-----------|----------------|----------------------|-------|
| BuildMachine | 1 | -- | Root state machine |
| FileManagerMachine | 1 | -- | Shared across all units |
| CadMachine | 1 per unique entry file | -- | Shared when multiple panels view the same file |
| KernelMachine | 1 per CadMachine | -- | Always 1:1 with CadMachine |
| Workers | 5 per KernelMachine | -- | All 5 created eagerly |
| GraphicsMachine | -- | 1 | WebGL renderer per panel |

### Memory Impact (Observed)

With a single build open:
- Main thread: ~575 MB
- replicad.worker: ~55-66 MB (includes OpenCASCADE WASM)
- openscad.worker: ~14 MB (includes Manifold WASM)
- jscad.worker: ~5 MB
- zoo.worker: ~3 MB
- tau.worker: ~5 MB
- file-manager worker: ~140 MB (ZenFS, file caches)

Total per KernelMachine: **~90 MB of worker memory** (regardless of which kernel is actually used).

With a multi-panel dockview (e.g., 4 panels viewing 4 files), this becomes 4 KernelMachines = **~360 MB of worker memory** plus a duplicated openscad worker set.

## Data Flow: File Edit to Geometry Display

```
1. User edits code in Monaco editor
   │
2. FileManager writes file → emits fileWritten event
   │
3. use-build.tsx subscription iterates all compilationUnits
   │
4. Each CadMachine receives setFile event
   │  ├─ Different file → immediate render
   │  └─ Same file → 500ms debounce (bufferingFile state)
   │
5. CadMachine enters rendering state → sends createGeometry to KernelMachine
   │
6. KernelMachine pipeline:
   │  ├─ determiningWorker: selects worker via canHandle (cached per filename)
   │  ├─ parsing: extracts parameters from bundled code
   │  └─ evaluating: executes code → returns geometries
   │
7. CadMachine receives geometryComputed → updates context.geometries
   │
8. ViewerContent useEffect bridges geometries → GraphicsMachine
   │
9. GraphicsMachine → CadViewer → GltfMesh renders to WebGL canvas
```

### Debouncing

| Trigger | Debounce | Rationale |
|---------|----------|-----------|
| File content change (same file) | 500ms | Avoids recompiling on every keystroke |
| Parameter change | 50ms | Slider drags need responsive feedback |
| File switch (different file) | 0ms | User intent is clear, render immediately |

## Worker Lifecycle

### Current: Eager Initialization

All 5 workers are created and initialized when `createWorkersActor` runs:

1. `new Worker()` for each (5 separate Web Worker threads)
2. `wrap<T>(worker)` via Comlink (proxy for cross-thread RPC)
3. `initializeEntry()` on each in parallel:
   - Sets up `onLog` callback (proxied)
   - Registers file manager MessagePort
   - Calls worker-specific `initialize()`:
     - JavaScript workers: register kernel modules on `globalThis.__KERNEL_MODULES__`
     - OpenScad: loads WASM + fonts
     - Zoo: stores API base URL
     - Tau: loads converter WASM

Workers remain alive for the entire KernelMachine lifetime. They are only destroyed when the CadMachine is stopped.

### Cleanup Chain

```
BuildMachine.stopStatefulActors()
  → enqueue.stopChild(cadMachine)
    → CadMachine stops
      → KernelMachine exit action: destroyWorkers()
        → wrappedWorker.cleanupEntry()
          → worker-specific cleanup()
        → rawWorker.terminate()
```

## Worker Selection (`canHandle`)

### Current Detection Strategy

Workers are queried in priority order until one claims the file:

```
Priority: openscad → zoo → replicad → jscad → tau
```

| Worker | Detection Method | Scope |
|--------|-----------------|-------|
| OpenScad | Extension: `.scad` | Entry file only |
| Zoo | Extension: `.kcl` | Entry file only |
| Replicad | Regex: `import ... from 'replicad'`, `require('replicad')`, destructured assignment, CDN imports | Entry file only |
| Jscad | Regex: `import ... from '@jscad/modeling'`, `require('@jscad/modeling')` | Entry file only |
| Tau | Extension: any supported import format (STEP, STL, etc.) | Entry file only |

### Known Limitations

1. **Entry-file-only detection**: `canHandle` only inspects the entry file, not transitive dependencies. A `main.ts` that imports from `./lib/cube.ts` (which imports `replicad`) will NOT be detected as a replicad file unless `main.ts` itself has a direct `import ... from 'replicad'` statement.

2. **Worker selection cache**: The `workerSelectionCache` (now scoped to KernelMachine context) caches the first successful `canHandle` result by filename. If an AI agent modifies the file to remove or change the kernel library, the cache correctly resets when the machine is recreated but persists within the same machine session.

3. **No multi-kernel support**: A file that uses both `replicad` and `@jscad/modeling` will be assigned to whichever worker matches first (replicad, due to priority order). There is no mechanism to delegate different operations to different kernels.

4. **Regex fragility**: The regex-based detection can produce false positives (matching imports in comments or strings) and false negatives (missing non-standard import patterns, dynamic imports).

## JavaScript Worker Architecture

### Class Hierarchy

```
KernelWorker<Options>  (abstract base)
  ├─ JavaScriptWorker<Options>  (esbuild bundler, module registry)
  │    ├─ ReplicadWorker  (OpenCASCADE BREP kernel)
  │    └─ JscadWorker     (CSG kernel)
  ├─ OpenScadWorker  (Manifold-based CSG)
  ├─ ZooWorker       (KCL cloud-native kernel)
  └─ TauWorker       (format converter, no computation)
```

### JavaScriptWorker Bundling Pipeline

```
1. Entry file path (e.g., /builds/id/main.ts)
   │
2. EsbuildBundler.bundle()
   │  ├─ ZenFS plugin resolves imports:
   │  │   ├─ Builtin modules (replicad, @jscad/modeling) → shim code from memory
   │  │   ├─ CDN modules (npm packages) → fetched and cached in /node_modules/
   │  │   ├─ HTTP URLs → fetched directly
   │  │   └─ Project files → read from ZenFS
   │  ├─ CommonJS auto-export injection for legacy patterns
   │  └─ esbuild bundles to single ESM output with source map
   │
3. JavaScriptWorker.execute()
   │  └─ Dynamic import via Blob URL (browser) or data URL (Node.js)
   │
4. JavaScriptWorker.runMain()
   │  ├─ ESM style: main(params)
   │  └─ CommonJS style: main(kernelModule, params)
   │
5. Worker-specific geometry conversion
   │  ├─ Replicad → GLTF via replicad-to-gltf
   │  └─ Jscad → GLTF via jscad-to-gltf
```

### Module Registry (`globalThis.__KERNEL_MODULES__`)

Each JavaScript worker registers its kernel library on `globalThis.__KERNEL_MODULES__`:

- ReplicadWorker: `replicad` (full module + source map for stack traces)
- JscadWorker: `@jscad/modeling` + 13 submodules (`primitives`, `booleans`, etc.)

The esbuild bundler generates ESM shim code that reads from this registry at runtime:

```javascript
// Generated shim for import { draw } from 'replicad'
const __m = globalThis.__KERNEL_MODULES__.get("replicad");
export const draw = __m.draw;
export default __m.default;
```

### Thread Isolation

Each worker runs in a separate Web Worker thread with its own:
- `globalThis` scope (no cross-worker pollution)
- `builtinModules` Map (per worker instance)
- esbuild bundler instance (initialized lazily per project path)
- Source map caches
- Module manager with CDN caches

## ESBuild Metafile

The bundler produces a metafile with all resolved module paths in `namespace:path` format:

| Namespace | Example Key | Description |
|-----------|-------------|-------------|
| `zenfs:` | `zenfs:main.ts` | Project-relative file |
| `zenfs:` | `zenfs:/node_modules/lodash/index.js` | CDN-cached module (absolute path) |
| `builtin:` | `builtin:replicad` | Runtime-registered kernel module |
| `http-url:` | `http-url:https://esm.sh/...` | HTTP-fetched module |

The metafile is currently used only for extracting project-file dependencies (for cache invalidation). It also contains information about which kernel libraries are used transitively, which could be leveraged for improved worker selection.
