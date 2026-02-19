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
                      └─ KernelRuntimeWorker (1 Web Worker per KernelMachine)
                           ├─ Loaded kernel module (via defineKernel)
                           ├─ Loaded bundler module (via defineBundler)
                           └─ Middleware chain (via defineMiddleware)
```

### Three-Pillar Plugin Model

All non-generic capabilities are provided by injectable plugins, not hardcoded in the framework:

| Plugin Type | API | Purpose | Example |
|-------------|-----|---------|---------|
| `defineKernel` | `KernelDefinition` | Geometry computation, parameter extraction, export | replicad, jscad, openscad, zoo, tau |
| `defineBundler` | `BundlerDefinition` | File bundling, code execution, module registry, import detection | esbuild bundler |
| `defineMiddleware` | `KernelMiddleware` | Operation wrapping (caching, transforms, edge detection) | geometry-cache, edge-detection |

### Machine Multiplicity

| Component | Per-build count | Per-viewer-panel count | Notes |
|-----------|----------------|----------------------|-------|
| BuildMachine | 1 | -- | Root state machine |
| FileManagerMachine | 1 | -- | Shared across all units |
| CadMachine | 1 per unique entry file | -- | Shared when multiple panels view the same file |
| KernelMachine | 1 per CadMachine | -- | Always 1:1 with CadMachine |
| KernelRuntimeWorker | 1 per KernelMachine | -- | Single worker, loads kernel on demand |
| GraphicsMachine | -- | 1 | WebGL renderer per panel |

### Memory Impact

With the single-worker-per-CU architecture, only the WASM runtime for the selected kernel is loaded:

- replicad file: ~55-66 MB (OpenCASCADE WASM)
- openscad file: ~14 MB (Manifold WASM)
- jscad file: ~5 MB
- kcl file: ~3 MB (KCL WASM)
- STEP/STL file: ~5 MB (converter)

Previously, all 5 kernels were loaded eagerly (~90 MB per CadMachine).

## Data Flow: File Edit to Geometry Display

```
1. User edits code in Monaco editor
   │
2. FileManager writes file → emits fileWritten event
   │
3. use-build.tsx iterates all compilationUnits with changed path (absolute)
   │
4. Each CadMachine receives setFile event
   │  ├─ Different file → immediate render
   │  └─ Same file → 500ms debounce (bufferingFile state)
   │
5. CadMachine enters rendering state → sends createGeometry to KernelMachine
   │
6. KernelMachine pipeline:
   │  ├─ Lazily creates the runtime worker (ensureRuntimeWorkerClient)
   │  ├─ Worker selects kernel via three-pass detection
   │  ├─ renderEntry: unified pipeline (deps → params → geometry)
   │  └─ Streams progress events back to CadMachine
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

### Lazy Initialization

The single KernelRuntimeWorker is created lazily on first render:

1. `new Worker(runtimeWorkerUrl, { type: 'module' })`
2. `client.initialize()` sends kernel config, middleware config, and bundler config
3. Worker loads bundler module via `import(bundlerModuleUrl)`
4. Kernel module loading is deferred until `selectKernel()` determines which kernel is needed

Only the WASM runtime for the selected kernel is ever loaded.

### Cleanup Chain

```
BuildMachine.stopStatefulActors()
  → enqueue.stopChild(cadMachine)
    → CadMachine stops
      → KernelMachine exit action: destroyWorkers()
        → runtimeWorkerClient.cleanup()
        → runtimeWorkerClient.terminate()
```

## Kernel Selection (Three-Pass Detection)

### Detection Strategy

```
1. Check selectionCache (full file path as key) → hit? return immediately

2. Pass 1: Extension + regex fast path
   - Try each kernel config's detectImport regex against the entry file
   - Extension-only kernels (openscad, zoo) match immediately
   - Regex kernels (replicad, jscad) test entry file content

3. Pass 2: Bundler-assisted detection (transitive)
   - If no kernel matched AND a bundler handles this extension:
   - Call bundler.detectImports(entryPath) — no modules need to be registered
   - detectImports marks bare specifiers as external, walks the full import tree
   - Returns { detectedModules: ['replicad'], dependencies: [...] }
   - Match detectedModules against each kernel config's builtinModuleNames
   - Select highest-priority match; initialize ALL matching kernels (multi-module)

4. Pass 3: Catch-all fallback
   - Try any extensions: ['*'] config (tau converter)
```

### Detection Priority

```
Priority: openscad → zoo → replicad → jscad → tau
```

| Kernel | Detection Method | Scope |
|--------|-----------------|-------|
| OpenScad | Extension: `.scad` | Immediate |
| Zoo | Extension: `.kcl` | Immediate |
| Replicad | Regex + bundler detectImports | Entry file + transitive |
| Jscad | Regex + bundler detectImports | Entry file + transitive |
| Tau | Extension: `*` (catch-all) | Fallback |

### Multi-Module Registration

When detection finds imports matching multiple kernels (e.g., both `replicad` and `@jscad/modeling`), the framework:

1. Selects the highest-priority kernel for geometry computation
2. Initializes ALL matching kernels so their modules are registered

This ensures all library modules are available at bundle time.

### Selection Cache Invalidation

The selection cache is invalidated when `notifyFileChanged` is called, since changed imports may shift which kernel handles a file. The cache uses full file paths as keys to prevent collisions.

## Plugin Architecture

### `defineBundler`

Bundler plugins handle file bundling, code execution, and module registry. The esbuild bundler (`esbuild.bundler.ts`) is the default implementation.

Key methods:
- `detectImports(input)` — lightweight pass that discovers bare-specifier imports transitively using esbuild externals mode. No modules need to be registered. Used for kernel selection.
- `bundle(input)` — full production bundle with all registered modules resolved. Called after kernel selection and initialization.
- `execute(code)` — run bundled code via dynamic import (Blob URL / data URL).
- `registerModule(name, module)` — register/update a builtin module for resolution during bundle().
- `resolveDependencies(input)` — optional fast-path dependency resolution.

### `defineKernel`

Kernel modules define geometry computation logic. Each kernel is an ES module loaded via `import(kernelModuleUrl)`:

- `initialize(options, runtime)` — load WASM, register builtin modules
- `canHandle(input, runtime, ctx)` — optional domain-specific check
- `getDependencies(input, runtime, ctx)` — return file dependencies
- `getParameters(input, runtime, ctx)` — extract parameters from code
- `createGeometry(input, runtime, ctx)` — compute geometry + return nativeHandle
- `exportGeometry(input, runtime, ctx, nativeHandle)` — export using stored handle

### MessagePort Protocol

The kernel machine communicates with the worker via typed MessagePort events:

- All request/response commands carry a `requestId` for correlation
- Fire-and-forget commands (`fileChanged`, `configureMiddleware`) have no requestId
- `cancel` command allows in-flight operations to be stopped
- `progress` events stream render phase transitions to the UI
- `telemetry` events batch performance entries for the kernel panel

### ESBuild Metafile

The bundler produces a metafile with all resolved module paths:

| Namespace | Example Key | Description |
|-----------|-------------|-------------|
| `zenfs:` | `zenfs:main.ts` | Project-relative file |
| `zenfs:` | `zenfs:/node_modules/lodash/index.js` | CDN-cached module |
| `builtin:` | `builtin:replicad` | Runtime-registered kernel module |
| `http-url:` | `http-url:https://esm.sh/...` | HTTP-fetched module |

During detection, bare specifiers appear as external imports in `metafile.outputs[chunk].imports` rather than in `metafile.inputs`, since they are not resolved.

## Caching Strategy

### File-Level Caches (persist across render cycles)

| Cache | Invalidation | Purpose |
|-------|-------------|---------|
| `fileHashCache` | Per-path via `notifyFileChanged` | Avoid re-hashing unchanged files |
| `fileContentCache` | Per-path via `notifyFileChanged` | Avoid re-reading unchanged files |
| `bundleResultCache` | Dependency-aware: only entries whose deps overlap with changed files | Avoid re-bundling when deps haven't changed |
| `selectionCache` | Cleared entirely on any file change | Ensure kernel detection re-runs when imports change |

### Per-Render Caches (cleared each render cycle)

| Cache | Purpose |
|-------|---------|
| `renderDependencyCache` | Reuse dependency computation between getParams and createGeometry |
| `cachedDetectionDeps` | Reuse deps from detectImports for getDependencies (zero cost) |
