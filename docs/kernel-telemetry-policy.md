# Kernel Telemetry Policy

Internal reference for the kernel worker telemetry system: span naming, hierarchy rules, attribute conventions, and performance contracts.

## Design Principles

- Every span must have a parent. No orphan root spans except the three permitted roots (`kernel.bootstrap`, `kernel.render`, `kernel.export`).
- The worker does the heavy lifting: span hierarchy, timing, and attributes are computed entirely on the worker thread. Consumers (UI, DevTools) receive pre-structured data and never need to reconstruct relationships.
- Span overhead must be negligible: monotonic counter IDs (not UUIDs), single `performance.mark()` per span start, no string concatenation in hot loops.
- The `KernelTracer` uses stack-based parent tracking via `activeSpanId`. Async/await naturally preserves hierarchy as long as spans are started and ended in the correct order within the same async context.

## Naming Convention

All span names follow the pattern `{subsystem}.{operation}`, inspired by OpenTelemetry semantic conventions.

| Subsystem | Scope | Examples |
|-----------|-------|---------|
| `kernel.*` | Framework lifecycle and infra | `kernel.bootstrap`, `kernel.render`, `kernel.init`, `kernel.select`, `kernel.detect-import`, `kernel.bundle`, `kernel.execute`, `kernel.compute`, `kernel.extract-params`, `kernel.export`, `kernel.resolve-deps`, `kernel.load-middleware`, `kernel.bundler-init` |
| `deps.*` | Dependency pipeline | `deps.discover`, `deps.read`, `deps.hash`, `deps.content-hash` |
| `fs.*` | Filesystem operations | `fs.read`, `fs.readBatch`, `fs.exists`, `fs.readdir` |
| `wasm.*` | WASM compilation | `wasm.compile` |
| `middleware.*` | Middleware wrapping | `middleware.wrap({MiddlewareName})` |
| `{kernelId}.*` | Kernel-authored spans | `replicad.wasm-init`, `replicad.run-main`, `replicad.font-load`, `replicad.mesh-to-gltf`, `openscad.wasm-init`, `openscad.call-main`, `openscad.mount-fonts`, `openscad.convert-geometry` |

### Rules

- Use lowercase with dots as separators.
- Framework spans use the `kernel.` prefix. Kernel-authored spans use the kernel's ID as prefix (e.g., `replicad.`, `openscad.`).
- Dynamic names are permitted only for `middleware.wrap({MiddlewareName})` where the middleware name is interpolated.
- New subsystem prefixes require updating this document.

## Root Span Policy

Exactly three root spans are permitted per worker lifecycle:

| Root Span | Lifecycle Phase | Context |
|-----------|----------------|---------|
| `kernel.bootstrap` | Worker initialization | Wraps middleware loading and kernel init |
| `kernel.render` | Render cycle | Wraps deps, params, geometry, and middleware for a single render |
| `kernel.export` | Geometry export | Wraps format conversion for file export |

All other spans MUST be children of one of these roots. If a span appears at root level in the telemetry tree, it is a bug.

## Span Hierarchy Reference

### Initialization (`kernel.bootstrap`)

```
kernel.bootstrap
├── kernel.load-middleware
└── kernel.init
```

### First Render (includes kernel selection)

```
kernel.render
├── kernel.resolve-deps
│   ├── kernel.select (first render only)
│   │   ├── kernel.detect-import
│   │   │   └── fs.read
│   │   ├── {kernelId}.wasm-init
│   │   │   └── wasm.compile
│   │   └── {kernelId}.font-load
│   ├── deps.discover
│   │   └── fs.read
│   ├── deps.read
│   │   └── fs.readBatch
│   ├── deps.hash
│   └── deps.content-hash
├── kernel.extract-params (via middleware chain)
│   └── middleware.wrap({Name})
│       └── kernel.bundle
│           ├── kernel.bundler-init (first bundle only)
│           └── kernel.execute
├── kernel.resolve-deps (for geometry)
│   └── deps.content-hash
└── kernel.compute (via middleware chain)
    └── middleware.wrap({Name})
        └── {kernelId}.run-main / {kernelId}.call-main
            └── {kernelId}.mesh-to-gltf / {kernelId}.convert-geometry
```

### Subsequent Renders (kernel already selected)

The `kernel.select` subtree is absent. The `kernel.bundler-init` subtree is absent (bundler already initialized). Cached middleware results may skip inner spans.

## Attribute Policy

Attributes are `Record<string, string | number | boolean>` only. No objects, no arrays.

| Span | Required Attributes | Optional Attributes |
|------|-------------------|-------------------|
| `kernel.bootstrap` | -- | `{ kernel }` (constructor name) |
| `kernel.render` | `{ file }` | -- |
| `kernel.export` | `{ format }` | -- |
| `kernel.select` | `{ file }` | -- |
| `kernel.detect-import` | `{ kernel }` (kernel ID being tested) | -- |
| `kernel.init` | `{ kernel }` | -- |
| `kernel.load-middleware` | `{ count }` | -- |
| `kernel.bundle` | `{ entryPath }` | -- |
| `kernel.bundler-init` | -- | -- |
| `deps.discover` | -- | -- |
| `deps.read` | `{ fileCount }` | -- |
| `deps.hash` | `{ fileCount }` | -- |
| `fs.read` | `{ path }` | -- |
| `fs.readBatch` | `{ fileCount }` | -- |
| `fs.exists` | `{ path }` | -- |
| `fs.readdir` | `{ path }` | -- |
| `wasm.compile` | `{ url }` | -- |
| `middleware.wrap(...)` | `{ middleware, phase }` | -- |
| `{kernelId}.wasm-init` | -- | `{ withExceptions }` |
| `{kernelId}.run-main` | -- | -- |
| `{kernelId}.mesh-to-gltf` | -- | `{ shapeCount }` |

### Guidelines

- Every `fs.*` span must include a `path` attribute so the UI can show what file was accessed.
- Every `middleware.wrap` span must include `middleware` (name) and `phase` (`getParameters` or `createGeometry`).
- Root spans should carry identifying context (file, kernel, format).
- Avoid high-cardinality attributes (e.g., full file contents, large arrays).

## Performance Contract

### Worker Side

- `KernelTracer.startSpan()` is O(1): monotonic ID increment, single `performance.mark()` call, push to active span stack.
- `KernelTracer.reset()` is called once per render cycle (at the start of `renderEntry`), not per span. It clears all accumulated marks and measures.
- `WorkerTelemetryCollector` batches entries via `PerformanceObserver` and flushes at 100ms intervals during long operations.
- Telemetry is explicitly flushed on render completion (before the `geometryComputed` response is sent) to ensure spans arrive before geometry results.

### Main Thread

- The telemetry aggregator forwards entries to the CAD machine immediately with zero processing overhead.
- No synchronous `performance.measure()` calls on the main thread event loop.
- `storeTelemetry` in the CAD machine appends entries to the context array, producing a new reference for React's `useSelector`.

### UI Side

- `buildSpanTree` reconstructs hierarchy from `spanId`/`parentSpanId` in a single O(n) pass.
- Depth assignment uses DFS from roots after tree construction (not incremental during the linking pass) to handle out-of-order `performance.measure` entries where children end before parents.
- `renderStart` and `renderDuration` are computed in a single iteration over `telemetryEntries` (no intermediate arrays).

## Implementation References

| Component | File | Role |
|-----------|------|------|
| `KernelTracer` | `apps/ui/app/components/geometry/kernel/utils/kernel-tracer.ts` | Span creation with parent-child hierarchy |
| `WorkerTelemetryCollector` | `apps/ui/app/components/geometry/kernel/utils/worker-telemetry.ts` | Batched collection via PerformanceObserver |
| `KernelWorkerDispatcher` | `apps/ui/app/components/geometry/kernel/utils/kernel-worker-dispatcher.ts` | Telemetry flush on render completion |
| `KernelWorker` | `apps/ui/app/components/geometry/kernel/utils/kernel-worker.ts` | Framework span instrumentation |
| `KernelRuntimeWorker` | `apps/ui/app/components/geometry/kernel/kernel-runtime-worker.ts` | Kernel selection spans |
| `buildSpanTree` | `apps/ui/app/routes/builds_.$id/chat-kernel.tsx` | UI tree reconstruction |
| `createTelemetryAggregator` | `apps/ui/app/machines/kernel.machine.ts` | Main-thread forwarding |
