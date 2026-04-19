---
title: 'Export Pipeline v4'
description: 'Complete implementation blueprint for pluggable export/import routing in @taucad/runtime: transcoder plugins, route planner, schema-driven config, type-safe client API, Tau kernel import rendering, and UI integration'
status: superseded
superseded_by: docs/research/export-pipeline-v5.md
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/export-pipeline-v3.md
  - docs/research/export-pipeline-v2.md
  - docs/policy/library-api-policy.md
  - docs/policy/vision-policy.md
  - docs/research/parameter-architecture-v2.md
---

# Export Pipeline v4

Implementation blueprint for the unified export/import pipeline in `@taucad/runtime`. This document supersedes `docs/research/export-pipeline-v3.md` by critiquing its gaps, resolving every open question, and producing a developer-ready blueprint with complete type definitions, consumer code examples, and protocol specifications.

## Executive Summary

v3 correctly identified that the runtime framework must not hardcode GLB as the only intermediate format and must not embed `@taucad/converter` as an internal dependency. Its introduction of the transcoder plugin primitive and framework route planner are architecturally sound. However, v3 left critical gaps: no specification for import-for-rendering (the Tau kernel's primary role today), incomplete contract alignment with existing runtime patterns, missing schema-driven export configuration detail, no protocol wire format, no type-safe client generics with transcoders, and no consumer-facing code examples. This document resolves all gaps and produces a complete blueprint.

## Table of Contents

- [Adversarial Critique of v3](#adversarial-critique-of-v3)
- [Scope and Non-Goals](#scope-and-non-goals)
- [Retained Decisions](#retained-decisions)
- [Architecture Overview](#architecture-overview)
- [Plugin Contracts](#plugin-contracts)
- [Plugin Factory Functions](#plugin-factory-functions)
- [Type-Safe Client Generics](#type-safe-client-generics)
- [Worker Discovery and Manifest](#worker-discovery-and-manifest)
- [Route Planning](#route-planning)
- [Middleware Interaction with Routed Exports](#middleware-interaction-with-routed-exports)
- [Protocol Wire Format](#protocol-wire-format)
- [Import-for-Rendering: The Tau Kernel Story](#import-for-rendering-the-tau-kernel-story)
- [Format Unification: Options Not Types](#format-unification-options-not-types)
- [Schema-Driven Export Configuration](#schema-driven-export-configuration)
- [Per-CU Export in the Autonomous Topology](#per-cu-export-in-the-autonomous-topology)
- [Dynamic Format Discovery for UI Consumers](#dynamic-format-discovery-for-ui-consumers)
- [Export Preference Persistence](#export-preference-persistence)
- [Consumer Code Examples](#consumer-code-examples)
- [Migration Plan](#migration-plan)
- [Recommendations](#recommendations)

## Adversarial Critique of v3

### Critique 1: Import-for-rendering is completely unaddressed

Today, when a user opens an STL file in the editor, the Tau kernel's `createGeometry` calls `importToGlb` to produce renderable GLB geometry. This is **kernel geometry evaluation** — the Tau kernel reads file bytes, produces tessellated geometry and a native handle (GLB bytes), and returns it for rendering.

v3's "Import Path Symmetry" section hand-waves: "Import route planning can be phased in after export migration without changing plugin primitives." This ignores that import-for-rendering is a **current, shipping capability** that must continue working throughout the migration. The Tau kernel's `canHandle` returns `true` for all `supportedImportFormats` — this kernel selection and rendering flow is load-bearing and must be explicitly addressed in the blueprint.

### Critique 2: `TranscoderDefinition` contract inconsistencies

v3's `TranscoderDefinition.initialize` uses `(input: { options: Options }, runtime: KernelRuntime)` — wrapping options in an input object. But `KernelDefinition.initialize` uses `(options: Options, runtime: KernelRuntime)` directly. This violates library-api-policy §4 (consistency principle): "A developer who learns one plugin interface should be able to predict the shape of another."

Additionally, `discoverCapabilities` passes `fromFormats`/`toFormats` from the registration object as input — but the module already knows its own capabilities. This is redundant parameter passing.

### Critique 3: `['*']` wildcard type defeats compile-time safety

v3's `TranscoderPlugin` allows `fromFormats: From | ['*']`. When a consumer registers a wildcard transcoder, the compile-time format union degrades to `string`, defeating v2's carefully designed type-safe `client.export()` constraint. A wildcard transcoder should widen the format union explicitly.

### Critique 4: Route planning complexity is underspecified

- Multi-hop routing adds significant planner complexity with no current real-world requirement. Every existing conversion is single-hop.
- Schema merging across multiple hops is unspecified. If kernel exports STEP with `assemblyMode` and a transcoder converts STEP→USDZ with `quality`, the UI needs both schemas — v3 does not design this.
- Tessellation handling in routed exports is entirely missing. v2 was explicit about export tessellation consistency; v3 drops it.

### Critique 5: Missing concrete details from v2

v3 drops all of the following, which a blueprint must include:

- Format unification (`stl-binary`/`step-assembly` removal)
- Schema layers (universal + format-specific Zod schemas)
- Tessellation resolution chain (per-export > client-level > kernel default)
- RJSF UI component design
- Export preference persistence schema and lifecycle
- Per-CU export orchestration from the UI layer
- Protocol wire format changes
- Client API export overloads
- Naming alignment table

### Critique 6: Middleware wrapping of routed exports is unspecified

When an export is routed through a transcoder (kernel → transcoder → output), does middleware wrap the entire operation or just the kernel leg? v2 was explicit: middleware wraps the outer operation. v3 says nothing.

### Critique 7: `ExportGeometryResult` reuse for transcoder output is semantically wrong

`ExportGeometryResult` is `KernelResult<ExportFile[]>`. A transcoder produces files, not geometry. The types work mechanically but the naming is misleading. The blueprint should address this.

### Critique 8: `TranscoderRuntime` vs `KernelRuntime` is unaddressed

A transcoder may not need filesystem access, bundler, or the same services as a kernel. v3 reuses `KernelRuntime` without justification.

### Critique 9: Over-engineering risk with multi-hop routing

For the foreseeable future, all conversions are single-hop. The blueprint should scope to single-hop and defer multi-hop, avoiding unnecessary complexity.

## Scope and Non-Goals

**In scope**: Complete blueprint for export pipeline overhaul including transcoder plugins, route planner, schema-driven config, type-safe client API, import-for-rendering support, UI integration, protocol changes, and migration plan.

**Out of scope**: Multi-hop transcoder routing (deferred), import-route orchestration via framework planner (deferred — Tau kernel continues handling import-for-rendering directly), standalone `/converter` route changes.

## Retained Decisions

These decisions from v2 and v3 are carried forward without change:

1. Worker-only Zod authoring; JSON Schema as the interop format crossing postMessage
2. `exportFormats` on `KernelPlugin` for compile-time type safety; `exportSchemas` as kernel module named export
3. Dynamic capability discovery emitted in `initialized` response
4. `fidelity` terminology (`'brep'` | `'mesh'`)
5. Per-CU runtime ownership (no `compilationUnit` arg on `client.export()`)
6. `.tau/export/preferences.json` for persistence
7. `stl-binary` and `step-assembly` removed from `ExportFormat`; replaced with schema options
8. Framework as orchestrator, plugins as capability providers
9. No hardcoded intermediate format; no hardcoded converter in framework core

## Architecture Overview

```text
┌───────────────────────────────────────────────────────────────┐
│ UI Layer                                                      │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│ │ Chat Export  │  │ AR Quick Look│  │ File Viewer (STL...)  │  │
│ │ Panel        │  │              │  │ (Tau kernel import)   │  │
│ └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│        │                 │                      │              │
│ ┌──────▼─────────────────▼──────────────────────▼───────────┐  │
│ │ Per-CU RuntimeClient                                      │  │
│ │ .export(format, options)  .render({ file })                │  │
│ └──────┬────────────────────────────┬───────────────────────┘  │
├────────┼────────────────────────────┼─────────────────────────┤
│ Worker │                            │                         │
│ ┌──────▼──────────────────┐  ┌──────▼──────────────────┐      │
│ │ Export Path             │  │ Render Path             │      │
│ │                         │  │                         │      │
│ │ Middleware onion        │  │ Middleware onion         │      │
│ │   ↓                    │  │   ↓                    │      │
│ │ Route planner           │  │ Kernel selection        │      │
│ │   ├─ direct kernel?     │  │   ↓                    │      │
│ │   │   → kernel.export() │  │ kernel.createGeometry() │      │
│ │   └─ else: route        │  │   (Tau: importToGlb)    │      │
│ │     → kernel.export(src)│  │                         │      │
│ │     → transcoder(→tgt)  │  │                         │      │
│ └─────────────────────────┘  └─────────────────────────┘      │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐    │
│ │ Plugin Registry                                         │    │
│ │ ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌─────────┐ │    │
│ │ │ Kernels  │ │ Transcoders  │ │Middleware│ │Bundlers │ │    │
│ │ │replicad  │ │converter     │ │cache     │ │esbuild  │ │    │
│ │ │manifold  │ │zooCloud      │ │coords    │ │         │ │    │
│ │ │tau       │ │              │ │edges     │ │         │ │    │
│ │ └──────────┘ └──────────────┘ └──────────┘ └─────────┘ │    │
│ └─────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

Four plugin categories, each with a clear concern:

| Plugin     | Concern                             | Contract           | Examples                     |
| ---------- | ----------------------------------- | ------------------ | ---------------------------- |
| Kernel     | Geometry evaluation + native export | `defineKernel`     | replicad, manifold, tau, zoo |
| Transcoder | Bytes-to-bytes format conversion    | `defineTranscoder` | converter, zooCloud          |
| Middleware | Cross-cutting interception          | `defineMiddleware` | cache, coordinate transform  |
| Bundler    | Source code bundling                | `defineBundler`    | esbuild                      |

## Plugin Contracts

### `TranscoderDefinition` — worker module contract

Following library-api-policy §2 (`defineX`), §4 (consistency), and §11 (no optional methods):

```typescript
type TranscoderDefinition<Context = unknown, Options extends Record<string, unknown> = Record<string, unknown>> = {
  /** Human-readable name for logs and error messages */
  name: string;
  /** Semantic version for cache-key computation and diagnostics */
  version: string;

  /** Zod schema for validating and typing transcoder options */
  optionsSchema?: z.ZodType<Options>;

  /**
   * Initialize the transcoder and return a context object.
   * Mirrors KernelDefinition.initialize signature for consistency.
   */
  initialize(options: Options, runtime: TranscoderRuntime): Promise<Context>;

  /**
   * Declare conversion edges this transcoder supports.
   * Called once during worker startup discovery. Returns a static or
   * dynamically-discovered set of (from, to) edges with metadata.
   */
  discoverEdges(runtime: TranscoderRuntime, context: Context): Promise<TranscoderEdge[]>;

  /**
   * Runtime guard: can this transcoder handle a specific conversion right now?
   * Called before each conversion attempt. Enables dynamic capability checks
   * (license validation, service health, account tier).
   * Return true to proceed, false to skip this transcoder in route fallback.
   */
  canTranscode(input: TranscodeInput, runtime: TranscoderRuntime, context: Context): Promise<boolean>;

  /**
   * Execute a single conversion step: transform input files from one format to another.
   */
  transcode(input: TranscodeInput, runtime: TranscoderRuntime, context: Context): Promise<TranscodeResult>;

  /** Tear down transcoder resources. Required per library-api-policy §11. */
  cleanup(context: Context): Promise<void>;
};
```

Supporting types:

```typescript
type TranscoderEdge = {
  from: string;
  to: string;
  fidelity: 'brep' | 'mesh';
  /** Zod schema for edge-specific options (converted to JSON Schema by worker) */
  optionsSchema?: z.ZodType;
  /** Relative cost hint for route ranking. Lower is preferred. Default: 1. */
  cost?: number;
};

type TranscodeInput = {
  from: string;
  to: string;
  files: ExportFile[];
  options?: Record<string, unknown>;
};

type TranscodeResult = KernelResult<ExportFile[]>;

type TranscoderRuntime = {
  logger: RuntimeLogger;
  tracer: RuntimeSpanTracer;
};
```

Design decisions:

- **`initialize(options, runtime)`** matches `KernelDefinition.initialize` signature — not wrapped in `{ options }`. Consistency principle (§4).
- **`discoverEdges(runtime, context)`** has no input object — the transcoder knows its own capabilities. No redundant `fromFormats`/`toFormats` pass-through.
- **`canTranscode` returns `boolean`**, not `{ supported, reason }`. Reasons belong in logs, not return values. Simpler consumer interface.
- **`TranscodeResult`** is `KernelResult<ExportFile[]>` — reuses the existing result pattern but is aliased for clarity.
- **`TranscoderRuntime`** is a focused subset of `KernelRuntime`: logger and tracer only. Transcoders do not need filesystem access, bundler, or kernel services. This prevents semantic leakage. The `KernelRuntime` type can be extended with an intersection if a transcoder needs filesystem access in the future.

### `defineTranscoder` — type inference helper

```typescript
function defineTranscoder<Context, Options extends Record<string, unknown> = Record<string, unknown>>(
  definition: TranscoderDefinition<Context, Options>,
): TranscoderDefinition<Context, Options> {
  return definition;
}
```

Follows the exact pattern of `defineKernel`, `defineMiddleware`, and `defineBundler`.

## Plugin Factory Functions

### `TranscoderPlugin` — main-thread registration type

```typescript
type TranscoderPlugin = {
  /** Unique identifier for this transcoder */
  id: string;
  /** URL of the transcoder module (resolved via import.meta.url) */
  moduleUrl: string;
  /** Transcoder-specific options passed to initialize() */
  options?: Record<string, unknown>;
};
```

Note: No `fromFormats`/`toFormats` on the registration type. Format capabilities are discovered at runtime by the worker calling `discoverEdges()`. This keeps the main-thread registration fully serializable and avoids stale static declarations.

### `createTranscoderPlugin` factory

```typescript
function createTranscoderPlugin(config: TranscoderPluginConfig): () => TranscoderPlugin;
function createTranscoderPlugin<Options extends Record<string, unknown>>(
  config: TranscoderPluginConfig | ((options: Options | undefined) => TranscoderPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => TranscoderPlugin : (options: Options) => TranscoderPlugin;
```

Follows the exact overload pattern of `createKernelPlugin`, `createMiddlewarePlugin`, and `createBundlerPlugin`.

### First-party transcoder factories

```typescript
// packages/runtime/src/plugins/transcoder-factories.ts

export const converterTranscoder = createTranscoderPlugin({
  id: 'converter',
  moduleUrl: new URL('../transcoders/converter/converter.transcoder.js', import.meta.url).href,
});
```

### `RuntimeClientOptions` extension

```typescript
type RuntimeClientOptions = {
  kernels: KernelPlugin[];
  transcoders?: TranscoderPlugin[];
  middleware?: MiddlewarePlugin[];
  bundlers?: BundlerPlugin[];
  transport?: RuntimeTransport;
  fileSystem?: RuntimeFileSystemBase;
  tessellation?: {
    preview?: Tessellation;
    export?: Tessellation;
  };
  renderTimeout?: number;
  sharedMemory?: {
    geometry?: SharedMemoryConfig;
  };
};
```

`transcoders` is optional. When omitted, the client has no fallback conversion — only kernel-native exports are available. This is the correct zero-config behavior for `@taucad/runtime` as a standalone library. Tau's `presets.all()` includes `converterTranscoder()` by default.

## Type-Safe Client Generics

### The problem with transcoder format unions

v2 designed `CollectExportFormats<Plugins>` to constrain `client.export()` to only formats declared by registered kernel plugins. With transcoders, additional formats become reachable — but the set depends on both kernel output formats AND transcoder edges, which are only known at runtime.

### Design decision: kernel formats for compile-time, manifest for runtime

Compile-time safety constrains to the union of all kernel `exportFormats`. This is the "guaranteed without network/service" set. Transcoder-augmented formats are available at runtime via the capabilities manifest and validated by the worker. The `export()` method accepts the kernel format union at compile time:

```typescript
type CollectExportFormats<Plugins extends readonly KernelPlugin[]> = Plugins[number]['exportFormats'][number];

function createRuntimeClient<K extends readonly KernelPlugin[]>(
  options: RuntimeClientOptions & { kernels: [...K] },
): RuntimeClient<CollectExportFormats<K>>;
```

For consumers who register transcoders and want to export transcoder-reachable formats, `export()` accepts `string` as a wider overload that undergoes runtime validation:

```typescript
type RuntimeClient<F extends string = string> = {
  export(format: F, options?: ExportOptions): Promise<ExportResult>;
  export(format: string, options?: ExportOptions): Promise<ExportResult>;
  // ... other methods
};
```

The narrower overload provides autocomplete for kernel-native formats. The wider overload accepts any string for transcoder-routed formats. The worker returns an actionable error if the format is unreachable.

## Worker Discovery and Manifest

### Startup discovery sequence

```text
Worker receives 'initialize' command
  1. Load kernel modules (dynamic import) + initialize
  2. Load transcoder modules (dynamic import) + initialize
  3. For each kernel: read exportSchemas, convert Zod → JSON Schema
  4. For each transcoder: call discoverEdges(), convert edge optionsSchemas → JSON Schema
  5. Compute export routes (kernel exports × transcoder edges)
  6. Assemble CapabilitiesManifest
  7. Respond with { type: 'initialized', capabilities }
```

### Manifest shape

```typescript
type ExportFormatCapability = {
  /** Which kernel provides this native export */
  kernelId: string;
  /** Export format identifier */
  format: string;
  /** Geometry representation fidelity */
  fidelity: 'brep' | 'mesh';
  /** JSON Schema for format-specific export options */
  schema: Record<string, unknown>;
  /** Default values extracted from Zod .default() */
  defaults: Record<string, unknown>;
};

type TranscodeEdgeCapability = {
  /** Which transcoder provides this conversion */
  transcoderId: string;
  /** Source format */
  from: string;
  /** Target format */
  to: string;
  /** Geometry representation fidelity */
  fidelity: 'brep' | 'mesh';
  /** JSON Schema for edge-specific options */
  schema: Record<string, unknown>;
  /** Default values */
  defaults: Record<string, unknown>;
  /** Route ranking hint (lower = preferred) */
  cost: number;
};

type ExportRoute = {
  /** Unique route identifier for logging and preference pinning */
  routeId: string;
  /** Target export format */
  targetFormat: string;
  /** Kernel providing the source format */
  kernelId: string;
  /** Kernel-native source format for the first leg */
  sourceFormat: string;
  /** Single transcoder hop (single-hop only in v4) */
  transcoderId: string;
  /** Resulting fidelity (min of kernel + transcoder fidelity) */
  fidelity: 'brep' | 'mesh';
  /** Composite score for ranking (lower = better) */
  score: number;
};

type CapabilitiesManifest = {
  /** Kernel-native export capabilities */
  kernelExports: ExportFormatCapability[];
  /** Transcoder conversion edges */
  transcodeEdges: TranscodeEdgeCapability[];
  /** Precomputed export routes (direct kernel + routed via transcoders) */
  exportRoutes: ExportRoute[];
};
```

### Client-side consumption

```typescript
type RuntimeClient<F extends string = string> = {
  readonly capabilities: CapabilitiesManifest;
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest) => void): () => void;
  // ... other methods
};
```

The `cad.machine` stores the manifest in context:

```typescript
cleanups.push(
  client.on('capabilities', (manifest) => {
    machineRef.send({ type: 'capabilitiesDiscovered', manifest });
  }),
);
```

## Route Planning

### Single-hop scope (v4)

v4 scopes routing to single-hop: `kernel export(sourceFormat) → transcoder(sourceFormat → targetFormat)`. Multi-hop routing is deferred — every real-world conversion today is single-hop. This dramatically simplifies the planner and eliminates cross-hop schema merging.

### Planning algorithm

For `client.export(targetFormat, options)` with active kernel `K`:

```text
1. If K.exportFormats includes targetFormat:
   → Direct route. No transcoder needed.
   → Score: 0 (always preferred).

2. For each sourceFormat in K.exportFormats:
   Find transcoder edges where edge.from === sourceFormat && edge.to === targetFormat.
   For each matching edge:
     → Routed candidate: K.export(sourceFormat) → transcoder(sourceFormat → targetFormat)
     → Score = edge.cost + fidelityPenalty(K.fidelity[sourceFormat], edge.fidelity)

3. Sort candidates by score ascending (lower = better).
   Tie-break: alphabetical by routeId for determinism.

4. Return ordered route list.
```

### Execution

```typescript
async function executeExport(
  targetFormat: string,
  options: Record<string, unknown>,
  kernel: LoadedKernel,
  registry: TranscoderRegistry,
  runtime: KernelRuntime,
): Promise<ExportGeometryResult> {
  const { tessellation: exportTessellation, ...formatOptions } = options;
  const resolvedTessellation = exportTessellation ?? clientOptions.tessellation?.export;

  // Direct kernel export
  if (kernel.entry.exportFormats.includes(targetFormat)) {
    return kernel.definition.exportGeometry(
      { format: targetFormat, tessellation: resolvedTessellation, nativeHandle, options: formatOptions },
      runtime,
      kernel.ctx,
    );
  }

  // Routed export
  const routes = planner.getRoutes(kernel.entry.id, targetFormat);

  for (const route of routes) {
    const transcoder = registry.get(route.transcoderId);

    const canProceed = await transcoder.definition.canTranscode(
      { from: route.sourceFormat, to: targetFormat, files: [], options: formatOptions },
      transcoder.runtime,
      transcoder.ctx,
    );
    if (!canProceed) continue;

    const sourceResult = await kernel.definition.exportGeometry(
      { format: route.sourceFormat, tessellation: resolvedTessellation, nativeHandle, options: {} },
      runtime,
      kernel.ctx,
    );
    if (!sourceResult.success) continue;

    const transcodeResult = await transcoder.definition.transcode(
      { from: route.sourceFormat, to: targetFormat, files: sourceResult.data, options: formatOptions },
      transcoder.runtime,
      transcoder.ctx,
    );
    if (transcodeResult.success) return transcodeResult;
  }

  return {
    success: false,
    issues: [
      {
        message:
          `No export route found for format "${targetFormat}" from kernel "${kernel.entry.id}". ` +
          `Native formats: ${kernel.entry.exportFormats.join(', ')}. ` +
          `Register a transcoder that supports this conversion.`,
        type: 'runtime',
        severity: 'error',
      },
    ],
  };
}
```

### Tessellation in routed exports

The kernel's first-leg export uses **export tessellation** (not preview tessellation). This ensures the intermediate file has the quality the user requested, regardless of what the preview renderer uses. The tessellation resolution chain:

1. Per-export: `client.export('stl', { tessellation: { ... } })`
2. Client-level: `createRuntimeClient({ tessellation: { export: { ... } } })`
3. Kernel default: when neither is provided

## Middleware Interaction with Routed Exports

Middleware wraps the **entire export operation** — the outer boundary. Middleware sees:

- **Input**: `format: 'usdz'` (the target format the consumer requested)
- **Output**: the final USDZ bytes (whether produced by direct kernel export or via routed conversion)

The internal route execution (kernel export to intermediate + transcoder conversion) is framework-internal and does NOT re-enter the middleware chain. This means:

- Logging middleware captures the full export operation
- Cache middleware can cache based on target format + dependency hash
- The intermediate format production is an implementation detail

This matches v2's explicit decision and is confirmed as correct.

## Protocol Wire Format

### Extended `RuntimeCommand`

```typescript
type RuntimeCommand =
  // ... existing commands unchanged ...
  {
    type: 'export';
    requestId: string;
    format: string;
    options?: Record<string, unknown>;
  };
```

Changes from current:

- `format` replaces `fileType` (naming alignment, matches `ExportFormat`)
- `tessellation` moves into `options.tessellation` (unified options model)
- `options` added for format-specific and universal export configuration

### Extended `RuntimeResponse`

```typescript
type RuntimeResponse =
  // ... existing responses ...
  | {
      type: 'initialized';
      requestId: string;
      capabilities: CapabilitiesManifest;
    }
  | {
      type: 'exported';
      requestId: string;
      result: ExportGeometryResult;
      route?: { routeId: string; sourceFormat: string; transcoderId: string };
    };
```

Changes:

- `initialized` now carries `capabilities` manifest
- `exported` gains optional `route` metadata for observability (which route was used)

### Initialize command extension

```typescript
| {
    type: 'initialize';
    requestId: string;
    kernelModules: KernelModuleEntry[];
    middlewareEntries: MiddlewareRegistrations;
    transcoderModules: TranscoderModuleEntry[];
    // ... existing fields
  }
```

New field: `transcoderModules` carries transcoder registrations to the worker.

```typescript
type TranscoderModuleEntry = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
};
```

## Import-for-Rendering: The Tau Kernel Story

### The problem

When a user opens `model.step` in Tau, the runtime must render it. This is not a conversion-to-file operation — it is geometry evaluation that produces renderable content. The Tau kernel handles this:

1. Kernel selection: `tau.canHandle({ extension: 'step' })` → `true` (checks `supportedImportFormats`)
2. `tau.createGeometry()` → reads file bytes → calls `importToGlb()` → returns `{ geometry: [glb], nativeHandle: glbBytes }`
3. Renderer displays the GLB geometry
4. On export: `tau.exportGeometry({ fileType: 'stl' })` → calls `exportFromGlb(glbBytes, 'stl')`

### Why import-for-rendering stays in the Tau kernel

Import-for-rendering is **kernel geometry evaluation** — it produces a `nativeHandle` and renderable geometry. This is the textbook `defineKernel` contract. A transcoder cannot do this: transcoders convert files but do not produce native handles or renderable geometry.

The Tau kernel continues to:

- Use `extensions: ['*']` with `canHandle` checking `supportedImportFormats`
- Internally depend on `@taucad/converter` for `importToGlb`
- Return GLB as its native handle

### Tau kernel export refactoring

With transcoder extraction, the Tau kernel's `exportGeometry` simplifies:

```typescript
// tau.kernel.ts — after refactoring
export default defineKernel({
  name: 'TauKernel',
  version: '2.0.0',

  // ... initialize, canHandle, getDependencies, getParameters, createGeometry unchanged ...

  async exportGeometry({ fileType, nativeHandle }, { logger }) {
    if (nativeHandle.length === 0) {
      return createKernelError([
        {
          message: 'No geometry available for export.',
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }

    // Tau kernel natively exports GLB/glTF only (its native handle IS GLB)
    if (fileType === 'glb') {
      return createKernelSuccess([createExportFile('glb', 'model.glb', nativeHandle)]);
    }
    if (fileType === 'gltf') {
      return createKernelSuccess([createExportFile('gltf', 'model.gltf', nativeHandle)]);
    }

    return createKernelError([
      {
        message:
          `Tau kernel only natively exports glb/gltf. Format "${fileType}" ` +
          `requires a transcoder. Register converterTranscoder() or another transcoder.`,
        type: 'runtime',
        severity: 'error',
      },
    ]);
  },
});
```

The Tau kernel factory declares its actual native export capability:

```typescript
// kernel-factories.ts
export const tau = createKernelPlugin({
  id: 'tau',
  moduleUrl: new URL('../kernels/tau/tau.kernel.js', import.meta.url).href,
  extensions: ['*'],
  exportFormats: ['glb', 'gltf'] as const,
});
```

Formats beyond GLB/glTF (STL, STEP, USDZ, etc.) are reached via `converterTranscoder` routes: `tau.export(glb) → converter(glb → stl)`.

### Converter transcoder implementation

```typescript
// transcoders/converter/converter.transcoder.ts
import { exportFromGlb } from '@taucad/converter';
import { supportedExportFormats, supportedImportFormats } from '@taucad/converter/formats';
import type { SupportedExportFormat, SupportedImportFormat } from '@taucad/converter/formats';
import { defineTranscoder } from '#types/runtime-transcoder.types.js';

export default defineTranscoder({
  name: 'ConverterTranscoder',
  version: '1.0.0',

  async initialize() {
    return {};
  },

  async discoverEdges() {
    const edges: TranscoderEdge[] = [];

    // GLB can be converted to all supported export formats
    for (const to of supportedExportFormats) {
      if (to === 'glb') continue;
      edges.push({ from: 'glb', to, fidelity: 'mesh', cost: 1 });
    }

    // All supported import formats can be converted to GLB
    for (const from of supportedImportFormats) {
      if (from === 'glb') continue;
      edges.push({ from, to: 'glb', fidelity: 'mesh', cost: 1 });
    }

    return edges;
  },

  async canTranscode({ from, to }) {
    return (
      supportedImportFormats.includes(from as SupportedImportFormat) &&
      supportedExportFormats.includes(to as SupportedExportFormat)
    );
  },

  async transcode({ from, to, files }) {
    const primaryFile = files[0];
    if (!primaryFile) {
      return { success: false, issues: [{ message: 'No input file', severity: 'error' }] };
    }

    // The converter's export pipeline expects GLB input
    const exported = await exportFromGlb(primaryFile.bytes, to as SupportedExportFormat);
    return { success: true, data: exported, issues: [] };
  },

  async cleanup() {},
});
```

### What this achieves

- `@taucad/converter` is **not** imported anywhere in `packages/runtime/src/framework/`
- `@taucad/converter` is imported only in specific plugin modules (`tau.kernel.ts`, `converter.transcoder.ts`)
- The runtime core is converter-agnostic
- Users who don't register `converterTranscoder()` get no converter dependency
- Import-for-rendering continues working via the Tau kernel exactly as today

## Format Unification: Options Not Types

Remove variant formats from `ExportFormat`:

```typescript
// libs/types/src/constants/file.constants.ts
const exportFormats = ['stl', 'step', 'glb', 'gltf', '3mf'] as const;
type ExportFormat = (typeof exportFormats)[number];
```

Binary and assembly mode become Zod schema options in the kernel module:

```typescript
// replicad.kernel.ts
export const exportSchemas = {
  stl: z.object({
    binary: z.boolean().default(true).describe('Binary STL'),
  }),
  step: z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single').describe('Assembly Mode'),
  }),
};
```

## Schema-Driven Export Configuration

### Zod for authoring, JSON Schema for interop

All export option schemas are authored in Zod inside kernel modules and transcoder modules. The worker converts them to JSON Schema during startup discovery. The main thread never imports Zod.

### Schema layers

**Layer 1: Universal options** — defined by the framework, applied to all exports:

```typescript
const universalExportSchema = z.object({
  tessellation: z
    .object({
      linearTolerance: z
        .number()
        .min(0.001)
        .max(10)
        .default(0.01)
        .describe('Maximum mesh-to-surface deviation (model units)'),
      angularTolerance: z.number().min(1).max(90).default(30).describe('Maximum facet angular deviation (degrees)'),
    })
    .optional()
    .describe('Tessellation Quality'),
  coordinateSystem: z.enum(['y-up', 'z-up']).optional().describe('Override the default coordinate convention'),
});
```

**Layer 2: Format-specific options** — declared by kernel module `exportSchemas`:

```typescript
const gltfExportSchema = z.object({
  compression: z.enum(['none', 'draco', 'meshopt']).default('none').describe('Compression'),
  draco: z
    .object({
      quantizationBits: z
        .object({
          position: z.number().int().min(8).max(16).default(14),
          normal: z.number().int().min(8).max(16).default(10),
        })
        .optional(),
    })
    .optional()
    .describe('Draco Options'),
});
```

### Tessellation resolution chain

1. Per-export options: `client.export('stl', { tessellation: { ... } })`
2. Client-level default: `createRuntimeClient({ tessellation: { export: { ... } } })`
3. Kernel built-in default (when neither is provided)

The framework extracts `tessellation` from merged options before dispatching:

```typescript
const { tessellation, ...formatOptions } = validatedOptions;
const resolvedTessellation = tessellation ?? clientOptions.tessellation?.export;

const kernelInput: ExportGeometryInput = {
  format,
  tessellation: resolvedTessellation,
  nativeHandle,
  options: formatOptions,
};
```

### Merged schema for UI

The UI reads from the capabilities manifest. For a selected format, the UI merges:

- Universal export JSON Schema (known statically)
- Format-specific JSON Schema from `manifest.kernelExports[format].schema`

This produces the full RJSF form. The UI never touches Zod.

### UI component

```typescript
type ExportSettingsProps = {
  format: ExportFormat;
  schema: RJSFSchema;
  defaults: Record<string, unknown>;
  values: Record<string, unknown>;
  onValuesChange: (values: Record<string, unknown>) => void;
};
```

Reuses `rjsf-theme.tsx`, `FieldTemplate`, `ModifiedIndicator`, and delta-extraction patterns from the parameter editor.

## Per-CU Export in the Autonomous Topology

Each `RuntimeClient` owns a single compilation unit. Export operates on the last-rendered geometry of that CU's native handle. There is no `compilationUnit` parameter on `client.export()`.

Multi-CU export is orchestrated by the UI:

```typescript
const { compilationUnits } = useProject();

for (const [entryFile, cadActor] of compilationUnits) {
  const snapshot = cadActor.getSnapshot();
  if (snapshot.context.geometries.length > 0 && snapshot.context.kernelClient) {
    const result = await snapshot.context.kernelClient.export(format, options);
    // Handle result per CU
  }
}
```

The chat-converter panel renders a CU selector (checkbox list of entry files with geometry) and exports each selected CU independently.

## Dynamic Format Discovery for UI Consumers

After capability discovery, the manifest is the sole source of truth for available formats. UI components derive format lists from the manifest's `exportRoutes`:

```typescript
const capabilities = useSelector(cadActor, (s) => s.context.capabilities);
const availableFormats = useMemo(() => {
  if (!capabilities) return [];

  const formatMap = new Map<string, { fidelity: 'brep' | 'mesh'; direct: boolean }>();

  for (const route of capabilities.exportRoutes) {
    const existing = formatMap.get(route.targetFormat);
    if (!existing || route.fidelity === 'brep') {
      formatMap.set(route.targetFormat, {
        fidelity: route.fidelity,
        direct: route.transcoderId === undefined,
      });
    }
  }

  return [...formatMap.entries()].map(([format, meta]) => ({ format, ...meta }));
}, [capabilities]);
```

Format display metadata (file extensions, MIME types) continues to come from `@taucad/types`. Any UI-specific enrichment (icons, labels) is a UI concern.

### Exception: Standalone converter route

The `/converter` route is a standalone product. It is the only acceptable direct consumer of `@taucad/converter` outside of plugin modules.

## Export Preference Persistence

### Storage location

```text
.tau/
├── parameters/
│   └── main.ts.json
└── export/
    └── preferences.json
```

### Schema

```typescript
type ExportPreferences = {
  formatOptions: Partial<Record<string, Record<string, unknown>>>;
  selectedFormats: string[];
  zipMultiple: boolean;
};
```

### Lifecycle

The project machine manages export preferences:

1. On first export panel open: read `.tau/export/preferences.json` (create with defaults if absent)
2. On format selection change: write updated `selectedFormats`
3. On export options change: write updated `formatOptions[format]`

## Consumer Code Examples

### Plugin author: defining a transcoder

```typescript
// my-cloud-transcoder.ts
import { z } from 'zod';
import { defineTranscoder } from '@taucad/runtime';

const optionsSchema = z.object({
  apiKey: z.string(),
  endpoint: z.string().default('https://api.example.com'),
});

export default defineTranscoder({
  name: 'MyCloudTranscoder',
  version: '1.0.0',
  optionsSchema,

  async initialize(options) {
    const client = await createApiClient(options.apiKey, options.endpoint);
    return { client };
  },

  async discoverEdges(_runtime, context) {
    const matrix = await context.client.getConversionMatrix();
    return matrix.map((entry) => ({
      from: entry.inputFormat,
      to: entry.outputFormat,
      fidelity: entry.preservesBRep ? ('brep' as const) : ('mesh' as const),
      cost: entry.estimatedLatencyMs / 1000,
    }));
  },

  async canTranscode({ from, to }, _runtime, context) {
    return context.client.isAvailable(from, to);
  },

  async transcode({ from, to, files, options }, _runtime, context) {
    const result = await context.client.convert({ from, to, fileData: files[0]!.bytes, options });
    return {
      success: true,
      data: [{ name: `model.${to}`, bytes: result.data, mimeType: result.mimeType }],
      issues: [],
    };
  },

  async cleanup(context) {
    await context.client.dispose();
  },
});
```

### Plugin author: registering a transcoder factory

```typescript
// transcoder-factories.ts
import { createTranscoderPlugin } from '@taucad/runtime';

type MyCloudOptions = { apiKey: string; endpoint?: string };

export const myCloudTranscoder = createTranscoderPlugin<MyCloudOptions>({
  id: 'my-cloud',
  moduleUrl: new URL('../transcoders/my-cloud/my-cloud.transcoder.js', import.meta.url).href,
});
```

### Consumer: creating a runtime client with transcoders

```typescript
import { createRuntimeClient } from '@taucad/runtime';
import { replicad, tau } from '@taucad/runtime/kernel';
import { converterTranscoder, myCloudTranscoder } from '@taucad/runtime/transcoder';
import { esbuild } from '@taucad/runtime/bundler';
import { parameterCache, geometryCache } from '@taucad/runtime/middleware';

const client = createRuntimeClient({
  kernels: [replicad(), tau()],
  transcoders: [converterTranscoder(), myCloudTranscoder({ apiKey: 'sk-...' })],
  bundlers: [esbuild()],
  middleware: [parameterCache(), geometryCache()],
  tessellation: {
    preview: { linearTolerance: 0.1, angularTolerance: 30 },
    export: { linearTolerance: 0.01, angularTolerance: 15 },
  },
});

await client.connect({ fileSystem });

// Listen for capabilities
client.on('capabilities', (manifest) => {
  console.log('Available export routes:', manifest.exportRoutes);
});

// Render a file
await client.render({ file: '/src/model.ts', parameters: { width: 50 } });

// Export — direct kernel route (replicad supports STEP natively)
const stepResult = await client.export('step', { assemblyMode: 'assembly' });

// Export — routed via converter transcoder (replicad → GLB → converter → USDZ)
const usdzResult = await client.export('usdz');

// Export — routed via commercial transcoder (replicad → STEP → myCloud → IGES)
const igesResult = await client.export('iges');
```

### Consumer: viewing a foreign CAD file

```typescript
// No change from today — the Tau kernel handles import-for-rendering

const client = createRuntimeClient({
  kernels: [replicad(), tau()],
  transcoders: [converterTranscoder()],
  bundlers: [esbuild()],
});

await client.connect({ fileSystem });

// Render a STEP file — Tau kernel selected, importToGlb produces geometry
await client.render({ file: '/models/assembly.step' });

// Export to STL — Tau exports GLB (native), converter transcodes GLB → STL
const stlResult = await client.export('stl', { binary: true });
```

## Migration Plan

### Phase 1: Plugin primitives and discovery

- Add `TranscoderPlugin`, `TranscoderDefinition`, `TranscoderRuntime`, `TranscodeInput`, `TranscodeResult` types
- Add `createTranscoderPlugin()` and `defineTranscoder()` factory/helper
- Add `transcoders` field to `RuntimeClientOptions`
- Extend `initialize` command and worker to load transcoder modules
- Implement worker-side transcoder Zod → JSON Schema conversion
- Extend `initialized` response with `CapabilitiesManifest`
- Emit `capabilities` event on `RuntimeClient`

### Phase 2: Export protocol and planner

- Add `options` to `ExportGeometryInput` and export protocol command
- Rename `fileType` → `format` on `ExportGeometryInput`
- Implement single-hop route planner in `KernelWorker`
- Execute direct kernel route first, then transcoder routes
- Add route metadata to `exported` response

### Phase 3: First-party transcoder extraction

- Implement `converter.transcoder.ts` wrapping `@taucad/converter`
- Refactor Tau kernel `exportGeometry` to only export GLB/glTF natively
- Update `tau` factory to `exportFormats: ['glb', 'gltf']`
- Add `converterTranscoder()` to `presets.all()`
- Verify import-for-rendering still works unchanged

### Phase 4: Format unification

- Remove `stl-binary` and `step-assembly` from `ExportFormat`
- Add corresponding Zod schema options to kernel modules
- Update all consumers of removed format variants

### Phase 5: UI and hooks consolidation

- Refactor chat-converter panel to use `RuntimeClient.export()` with dynamic format list from manifest
- Migrate `use-ar.ts` to `RuntimeClient.export('usdz')`
- Deprecate `useGeometryExport` in `@taucad/react`
- Build `ExportSettings` RJSF component using manifest schemas

### Phase 6: Preference persistence and cleanup

- Implement `.tau/export/preferences.json` persistence in project machine
- Remove `@taucad/converter` from `apps/ui` and `packages/react` `package.json`
- Remove command palette export items; single "Open Exporter" command

## Recommendations

| #   | Action                                                                                   | Priority | Effort | Impact                                  |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------- |
| R1  | Add `TranscoderPlugin` + `defineTranscoder` + `TranscoderRuntime` types                  | P0       | Medium | High — enables pluggable conversion     |
| R2  | Add `createTranscoderPlugin()` factory following existing plugin helper pattern          | P0       | Low    | High — consumer DX                      |
| R3  | Extend worker initialization to load transcoders and emit `CapabilitiesManifest`         | P0       | Medium | High — autonomous discovery             |
| R4  | Implement single-hop route planner in framework export handler                           | P0       | High   | High — core orchestration               |
| R5  | Implement `converterTranscoder` wrapping `@taucad/converter`                             | P0       | Medium | High — first-party fallback             |
| R6  | Refactor Tau kernel to only natively export GLB/glTF                                     | P0       | Low    | High — cleaner capability declaration   |
| R7  | Add `options` to export protocol and `ExportGeometryInput`; rename `fileType` → `format` | P0       | Low    | High — naming + config                  |
| R8  | Remove `stl-binary` and `step-assembly` from `ExportFormat`                              | P1       | Medium | High — cleaner format model             |
| R9  | Add `transcoders` to `RuntimeClientOptions` and `presets.all()`                          | P0       | Low    | High — consumer-facing                  |
| R10 | Build `ExportSettings` RJSF component using manifest schemas                             | P1       | Medium | High — user-facing config               |
| R11 | Implement export preference persistence under `.tau/export/`                             | P2       | Medium | Medium — remembers choices              |
| R12 | Migrate chat-converter, AR, `@taucad/react` hooks to runtime export                      | P1       | Medium | High — consolidation                    |
| R13 | Expose route metadata in `exported` response for observability                           | P1       | Low    | Medium — debuggability                  |
| R14 | Remove `@taucad/converter` from `apps/ui` and `@taucad/react` deps                       | P2       | Low    | Medium — enforces boundary              |
| R15 | Set `tessellation.export` in `defaultKernelOptions`                                      | P0       | Low    | High — prevents silent quality fallback |

## References

- Export Pipeline v3: `docs/research/export-pipeline-v3.md`
- Export Pipeline v2: `docs/research/export-pipeline-v2.md`
- Library API Policy: `docs/policy/library-api-policy.md`
- Vision Policy: `docs/policy/vision-policy.md`
- Parameter Architecture v2: `docs/research/parameter-architecture-v2.md`
- Runtime client: `packages/runtime/src/client/runtime-client.ts`
- Kernel definition types: `packages/runtime/src/types/runtime-kernel.types.ts`
- Runtime protocol: `packages/runtime/src/types/runtime-protocol.types.ts`
- Plugin types/helpers: `packages/runtime/src/plugins/plugin-types.ts`, `packages/runtime/src/plugins/plugin-helpers.ts`
- Tau kernel: `packages/runtime/src/kernels/tau/tau.kernel.ts`
- Zoo kernel: `packages/runtime/src/kernels/zoo/zoo.kernel.ts`
- Converter APIs: `packages/converter/src/conversion.ts`, `packages/converter/src/formats.ts`
- Kernel runtime worker: `packages/runtime/src/framework/kernel-runtime-worker.ts`
- Kernel worker: `packages/runtime/src/framework/kernel-worker.ts`
- Worker dispatcher: `packages/runtime/src/framework/runtime-worker-dispatcher.ts`

## Appendix

### A. Naming Alignment

| Concept          | Plugin (main)          | Worker Module           | Manifest                      | Client API             | Protocol               | Kernel Input                     |
| ---------------- | ---------------------- | ----------------------- | ----------------------------- | ---------------------- | ---------------------- | -------------------------------- |
| Target format    | `plugin.exportFormats` | `exportSchemas[fmt]`    | `exportRoutes[].targetFormat` | `export(format)`       | `command.format`       | `input.format`                   |
| Source format    | —                      | —                       | `exportRoutes[].sourceFormat` | —                      | `route.sourceFormat`   | —                                |
| Schema authoring | —                      | Zod (kernel/transcoder) | —                             | —                      | —                      | —                                |
| Schema interop   | —                      | —                       | JSON Schema                   | RJSF                   | —                      | —                                |
| Options          | —                      | —                       | `defaults`                    | `export(f, options)`   | `command.options`      | `input.options`                  |
| Tessellation     | —                      | —                       | (in schema)                   | `options.tessellation` | `options.tessellation` | `input.tessellation` (extracted) |
| Fidelity         | —                      | —                       | `fidelity`                    | —                      | —                      | —                                |

### B. Plugin Registration Summary

| Plugin Type | Registration Type  | Factory Helper           | Define Helper      | Worker Contract        |
| ----------- | ------------------ | ------------------------ | ------------------ | ---------------------- |
| Kernel      | `KernelPlugin`     | `createKernelPlugin`     | `defineKernel`     | `KernelDefinition`     |
| Transcoder  | `TranscoderPlugin` | `createTranscoderPlugin` | `defineTranscoder` | `TranscoderDefinition` |
| Middleware  | `MiddlewarePlugin` | `createMiddlewarePlugin` | `defineMiddleware` | `MiddlewareDefinition` |
| Bundler     | `BundlerPlugin`    | `createBundlerPlugin`    | `defineBundler`    | `BundlerDefinition`    |

### C. Compatibility Posture

This architecture is a forward rollout with no public compatibility guarantees required. API and protocol renames prioritize conceptual correctness. `@taucad/runtime` is consumed as source — there are no published artifacts to maintain backward compatibility with.

### D. Export Options Schema per Format

Authored in Zod in kernel modules, converted to JSON Schema by the worker.

| Format       | Option                            | Zod Type                               | Default        |
| ------------ | --------------------------------- | -------------------------------------- | -------------- |
| **All**      | `tessellation.linearTolerance`    | `z.number().min(0.001).max(10)`        | `0.01`         |
| **All**      | `tessellation.angularTolerance`   | `z.number().min(1).max(90)`            | `30`           |
| **All**      | `coordinateSystem`                | `z.enum(['y-up', 'z-up']).optional()`  | Format default |
| **stl**      | `binary`                          | `z.boolean()`                          | `true`         |
| **step**     | `assemblyMode`                    | `z.enum(['single', 'assembly'])`       | `'single'`     |
| **glb/gltf** | `compression`                     | `z.enum(['none', 'draco', 'meshopt'])` | `'none'`       |
| **glb/gltf** | `draco.quantizationBits.position` | `z.number().int().min(8).max(16)`      | `14`           |
| **glb/gltf** | `draco.quantizationBits.normal`   | `z.number().int().min(8).max(16)`      | `10`           |
| **3mf**      | `units`                           | `z.enum(['millimeter', 'inch'])`       | `'millimeter'` |

### E. Per-Kernel Export Format Matrix

| Kernel          | exportFormats                    | Fidelity                   |
| --------------- | -------------------------------- | -------------------------- |
| Replicad        | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) |
| OpenCascade     | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) |
| Manifold        | `['glb', 'gltf']`                | mesh                       |
| OpenSCAD        | `['stl', 'glb', 'gltf', '3mf']`  | mesh                       |
| JSCAD           | `['glb', 'gltf']`                | mesh                       |
| Zoo (KCL)       | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) |
| Tau (converter) | `['glb', 'gltf']`                | mesh                       |

Formats beyond a kernel's native set are reachable via transcoder routes.
