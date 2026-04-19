---
title: 'Export Pipeline v5'
description: 'Canonical implementation blueprint for pluggable export/import routing in @taucad/runtime: transcoder plugins, minimum-viable route planner, schema-driven config, type-safe client API, Tau kernel import rendering, co-located plugin pattern, and complete protocol specification'
status: draft
created: '2026-04-09'
updated: '2026-04-09'
category: architecture
related:
  - docs/research/export-pipeline-v4.md
  - docs/policy/library-api-policy.md
  - docs/policy/vision-policy.md
  - docs/architecture/runtime-topology.md
  - docs/research/parameter-architecture-v2.md
---

# Export Pipeline v5

Canonical implementation blueprint for the unified export pipeline in `@taucad/runtime`. Introduces transcoder plugins as a new runtime primitive, a minimum-viable single-hop route planner, schema-driven export configuration, and converter decoupling from framework internals. Designed to be consumed directly by a planning agent for task decomposition.

## Executive Summary

The export pipeline overhaul introduces one new plugin primitive — **transcoder plugins** — and a **minimum-viable single-hop route planner** to the runtime framework. Kernels remain responsible for geometry evaluation and native export. Transcoders handle bytes-to-bytes format conversion. The framework orchestrates: direct kernel export first, then transcoder-routed fallback. `@taucad/converter` is extracted from framework internals into a first-party transcoder plugin. The Tau kernel continues handling import-for-rendering via its `createGeometry` method unchanged. Schema-driven export configuration uses Zod on the worker, JSON Schema for interop, and RJSF for UI forms.

## Table of Contents

- [Scope and Non-Goals](#scope-and-non-goals)
- [Architecture Overview](#architecture-overview)
- [Plugin Contracts](#plugin-contracts)
- [Plugin Registration and Factories](#plugin-registration-and-factories)
- [Co-located Plugin File Layout](#co-located-plugin-file-layout)
- [RuntimeClientOptions Extension](#runtimeclientoptions-extension)
- [Type-Safe Client Generics](#type-safe-client-generics)
- [Worker Discovery and Capabilities Manifest](#worker-discovery-and-capabilities-manifest)
- [Minimum-Viable Route Planner](#minimum-viable-route-planner)
- [Middleware Interaction with Routed Exports](#middleware-interaction-with-routed-exports)
- [Protocol Wire Format](#protocol-wire-format)
- [Import-for-Rendering: Tau Kernel](#import-for-rendering-tau-kernel)
- [Converter Transcoder Implementation](#converter-transcoder-implementation)
- [Format Unification](#format-unification)
- [Schema-Driven Export Configuration](#schema-driven-export-configuration)
- [Per-CU Export in the Autonomous Topology](#per-cu-export-in-the-autonomous-topology)
- [Dynamic Format Discovery for UI Consumers](#dynamic-format-discovery-for-ui-consumers)
- [Export Preference Persistence](#export-preference-persistence)
- [Consumer Code Examples](#consumer-code-examples)
- [File Inventory: New and Modified](#file-inventory-new-and-modified)
- [Migration Plan](#migration-plan)
- [Recommendations](#recommendations)
- [Appendix](#appendix)

## Scope and Non-Goals

**In scope**: Complete specification for export pipeline overhaul — transcoder plugin primitive, minimum-viable single-hop route planner, schema-driven config, type-safe client API, import-for-rendering continuity, UI integration, protocol changes, file layout, and phased migration.

**Out of scope**: Multi-hop transcoder routing (deferred). Import-route orchestration via framework planner (deferred — Tau kernel handles import-for-rendering directly). Standalone `/converter` route changes.

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
│ │ .export(format, options?)  .render({ file })               │  │
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
│ │   └─ else: routed       │  │   (Tau: importToGlb)    │      │
│ │     → kernel.export(src)│  │                         │      │
│ │     → transcoder(→tgt)  │  │                         │      │
│ └─────────────────────────┘  └─────────────────────────┘      │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐    │
│ │ Plugin Registry                                         │    │
│ │ ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌─────────┐ │    │
│ │ │ Kernels  │ │ Transcoders  │ │Middleware│ │Bundlers │ │    │
│ │ │replicad  │ │converter     │ │paramCache│ │esbuild  │ │    │
│ │ │manifold  │ │zooCloud      │ │geoCache  │ │         │ │    │
│ │ │tau       │ │              │ │gltfCoord │ │         │ │    │
│ │ └──────────┘ └──────────────┘ └──────────┘ └─────────┘ │    │
│ └─────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

Four plugin categories:

| Plugin     | Concern                             | Define Contract    | Examples                      |
| ---------- | ----------------------------------- | ------------------ | ----------------------------- |
| Kernel     | Geometry evaluation + native export | `defineKernel`     | replicad, manifold, tau, zoo  |
| Transcoder | Bytes-to-bytes format conversion    | `defineTranscoder` | converter, zooCloud           |
| Middleware | Cross-cutting interception          | `defineMiddleware` | parameterCache, geometryCache |
| Bundler    | Source code bundling                | `defineBundler`    | esbuild                       |

## Plugin Contracts

### `TranscoderDefinition` — worker module contract

Following library-api-policy §2 (`defineX`), §4 (consistency), and §11 (no optional methods):

```typescript
type TranscoderDefinition<Context = unknown, Options extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  version: string;
  optionsSchema?: z.ZodType<Options>;

  initialize(options: Options, runtime: TranscoderRuntime): Promise<Context>;

  discoverEdges(runtime: TranscoderRuntime, context: Context): Promise<TranscoderEdge[]>;

  canTranscode(input: TranscodeInput, runtime: TranscoderRuntime, context: Context): Promise<boolean>;

  transcode(input: TranscodeInput, runtime: TranscoderRuntime, context: Context): Promise<TranscodeResult>;

  cleanup(context: Context): Promise<void>;
};
```

### Supporting types

```typescript
type TranscoderEdge = {
  from: string;
  to: string;
  fidelity: 'brep' | 'mesh';
  optionsSchema?: z.ZodType;
};

type TranscodeInput = {
  from: string;
  to: string;
  files: ExportFile[];
  options?: Record<string, unknown>;
};

type TranscodeResult = KernelResult<ExportFile[]>;
```

### `TranscoderRuntime` — focused subset of `KernelRuntime`

```typescript
type TranscoderRuntime = {
  logger: RuntimeLogger;
  tracer: RuntimeSpanTracer;
};
```

Transcoders do not need filesystem access, bundler, or kernel lifecycle services. This keeps the surface minimal and prevents semantic leakage. If a future transcoder requires filesystem access (e.g., for temp file staging), `TranscoderRuntime` can be extended with an intersection.

### `defineTranscoder` — type inference helper

```typescript
function defineTranscoder<Context, Options extends Record<string, unknown> = Record<string, unknown>>(
  definition: TranscoderDefinition<Context, Options>,
): TranscoderDefinition<Context, Options> {
  return definition;
}
```

Follows the exact pattern of `defineKernel`, `defineMiddleware`, and `defineBundler`.

### Design decisions

| Decision                                                    | Rationale                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `initialize(options, runtime)` not `({ options }, runtime)` | Matches `KernelDefinition.initialize` signature (§4 consistency)                                            |
| `discoverEdges(runtime, context)` with no input             | Transcoder knows its own capabilities; no redundant pass-through                                            |
| `canTranscode` returns `boolean`                            | Reasons belong in logs, not return values                                                                   |
| `TranscodeResult = KernelResult<ExportFile[]>`              | Reuses existing result pattern with alias for clarity                                                       |
| `cleanup` is required                                       | Per §11. Existing `KernelDefinition.cleanup` is optional; new contracts follow the no-optional-methods rule |
| No `cost` field on `TranscoderEdge`                         | Minimum-viable for single-hop; registration order provides deterministic ranking                            |

## Plugin Registration and Factories

### `TranscoderPlugin` — main-thread registration type

```typescript
type TranscoderPlugin = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
};
```

No `fromFormats`/`toFormats` on the registration type. Format capabilities are discovered at runtime by the worker calling `discoverEdges()`. This keeps the main-thread registration fully serializable and avoids stale static declarations that drift from runtime capabilities.

### `createTranscoderPlugin` factory

```typescript
// --- Transcoder ---

type TranscoderPluginConfig = Omit<TranscoderPlugin, 'options'>;

function createTranscoderPlugin(config: TranscoderPluginConfig): () => TranscoderPlugin;
function createTranscoderPlugin<Options extends Record<string, unknown>>(
  config: TranscoderPluginConfig | ((options: Options | undefined) => TranscoderPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => TranscoderPlugin : (options: Options) => TranscoderPlugin;
function createTranscoderPlugin(
  config: TranscoderPluginConfig | ((options?: Record<string, unknown>) => TranscoderPluginConfig),
): (options?: Record<string, unknown>) => TranscoderPlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    return { ...resolved, options };
  };
}
```

Exact same overload pattern as `createKernelPlugin`, `createMiddlewarePlugin`, `createBundlerPlugin`.

### `KernelPlugin` extension — `exportFormats`

`KernelPlugin` includes an `exportFormats` field:

```typescript
type KernelPlugin = {
  id: string;
  moduleUrl: string;
  extensions: string[];
  detectImport?: RegExp;
  builtinModuleNames?: string[];
  options?: Record<string, unknown>;
  /** Formats this kernel can natively export. Used for compile-time type safety and route planning. */
  exportFormats?: readonly string[];
};
```

`exportFormats` is optional for backward compatibility — existing kernel registrations without it continue to work (they simply don't contribute to compile-time format unions or route planning until updated).

## Co-located Plugin File Layout

Following the established kernel pattern where each kernel owns its registration in a co-located `*.plugin.ts` file:

```text
packages/runtime/src/
├── kernels/
│   ├── replicad/
│   │   ├── replicad.kernel.ts          # defineKernel implementation
│   │   └── replicad.plugin.ts          # createKernelPlugin factory
│   ├── tau/
│   │   ├── tau.kernel.ts
│   │   └── tau.plugin.ts
│   └── ...
├── transcoders/                         # NEW directory
│   └── converter/
│       ├── converter.transcoder.ts      # defineTranscoder implementation
│       └── converter.plugin.ts          # createTranscoderPlugin factory
├── plugins/
│   ├── plugin-types.ts                  # MODIFIED: add TranscoderPlugin
│   ├── plugin-helpers.ts                # MODIFIED: add createTranscoderPlugin
│   ├── kernel-factories.ts             # Barrel re-export of kernel plugins
│   ├── transcoder-factories.ts          # NEW: barrel re-export of transcoder plugins
│   ├── middleware-factories.ts
│   ├── bundler-factories.ts
│   └── presets.ts                       # MODIFIED: add converterTranscoder()
└── types/
    ├── runtime-kernel.types.ts          # MODIFIED: ExportGeometryInput
    ├── runtime-transcoder.types.ts      # NEW: TranscoderDefinition, etc.
    ├── runtime-protocol.types.ts        # MODIFIED: export command, initialized
    └── runtime.types.ts                 # MODIFIED: CapabilitiesManifest
```

### Subpath export

```text
@taucad/runtime/transcoder  →  packages/runtime/src/plugins/transcoder-factories.ts
```

Following the singular subpath naming convention from library-api-policy §6.

## RuntimeClientOptions Extension

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

`transcoders` is optional. When omitted, only kernel-native exports are available. `presets.all()` includes `converterTranscoder()` by default so Tau users get fallback conversion out of the box.

### `createRuntimeClientOptions` merge support

`transcoders` is added to `pluginArrayKeys` in `runtime-client-options.ts` for ID-based merge support:

```typescript
const pluginArrayKeys = new Set(['kernels', 'middleware', 'bundlers', 'transcoders']);
```

## Type-Safe Client Generics

### Compile-time: kernel format union

```typescript
type CollectExportFormats<Plugins extends readonly KernelPlugin[]> = Plugins[number] extends {
  exportFormats: readonly (infer F)[];
}
  ? F
  : string;
```

When all kernel plugins declare `exportFormats`, the union constrains `client.export()` to those formats. When any kernel omits `exportFormats`, the union widens to `string`.

### Runtime: manifest for transcoder-reachable formats

Transcoder-augmented formats are available at runtime via the capabilities manifest and validated by the worker.

### Client export signature

```typescript
type RuntimeClient<F extends string = string> = {
  export(format: F, options?: ExportOptions): Promise<ExportResult>;
  export(format: string, options?: ExportOptions): Promise<ExportResult>;

  readonly capabilities: CapabilitiesManifest | undefined;
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest) => void): () => void;
  // ... other existing methods
};

type ExportOptions = Record<string, unknown> & {
  tessellation?: Tessellation;
};
```

The narrower overload provides autocomplete for kernel-native formats. The wider overload accepts any string for transcoder-routed formats. The worker returns an actionable error if the format is unreachable.

## Worker Discovery and Capabilities Manifest

### Startup discovery sequence

```text
Worker receives 'initialize' command
  1. Load + initialize kernel modules
  2. Load + initialize transcoder modules
  3. For each kernel: read exportSchemas named export, convert Zod → JSON Schema
  4. For each transcoder: call discoverEdges(), convert edge optionsSchemas → JSON Schema
  5. Compute export routes (kernel exportFormats × transcoder edges)
  6. Assemble CapabilitiesManifest
  7. Include manifest in 'initialized' response
```

### Manifest types

```typescript
type ExportFormatCapability = {
  kernelId: string;
  format: string;
  fidelity: 'brep' | 'mesh';
  schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
};

type TranscodeEdgeCapability = {
  transcoderId: string;
  from: string;
  to: string;
  fidelity: 'brep' | 'mesh';
  schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
};

type ExportRoute = {
  routeId: string;
  targetFormat: string;
  kernelId: string;
  sourceFormat: string;
  transcoderId?: string;
  fidelity: 'brep' | 'mesh';
};

type CapabilitiesManifest = {
  kernelExports: ExportFormatCapability[];
  transcodeEdges: TranscodeEdgeCapability[];
  exportRoutes: ExportRoute[];
};
```

Note: `ExportRoute.transcoderId` is `undefined` for direct kernel routes. `ExportRoute` has no `score` — ranking is implicit by array position (direct routes first, then by fidelity preference, then by registration order).

### Route computation

Routes are computed once during initialization and stored in the manifest. The worker iterates:

1. For each kernel with `exportFormats`, add a direct route for each format (no transcoder).
2. For each transcoder edge, for each kernel whose `exportFormats` includes `edge.from`, add a routed entry with `transcoderId`.
3. Order: direct routes first, then brep-fidelity routes, then mesh-fidelity routes. Within same fidelity, transcoder registration order determines preference.

### Client-side consumption

The `RuntimeClient` exposes the manifest and a `'capabilities'` event:

```typescript
client.on('capabilities', (manifest) => {
  // UI updates available export formats
});
```

The `cad.machine` stores the manifest in context and forwards to the chat-converter panel.

## Minimum-Viable Route Planner

### Design principle: engineer to specification

The planner handles exactly what is needed today — single-hop routing with deterministic preference. No graph search. No cost arithmetic. No multi-hop. The implementation is a simple lookup function, not a sophisticated planning engine.

### Algorithm

For `client.export(targetFormat, options)` on the active kernel:

```text
1. Look up the active kernel's exportFormats.
2. If exportFormats includes targetFormat → direct kernel export. Done.
3. Else, iterate precomputed routes from the manifest:
   - Filter to routes where kernelId matches and targetFormat matches.
   - Routes are already sorted (brep first, then registration order).
   - For each candidate route:
     a. Call transcoder.canTranscode() — runtime guard.
     b. If true, execute the route. Done.
4. If no route succeeds → return actionable error.
```

### Implementation

```typescript
async function executeExport(
  targetFormat: string,
  options: ExportOptions,
  kernel: LoadedKernel,
  transcoderRegistry: TranscoderRegistry,
  runtime: KernelRuntime,
  nativeHandle: unknown,
  clientTessellation: Tessellation | undefined,
): Promise<ExportGeometryResult> {
  const { tessellation: perExportTessellation, ...formatOptions } = options;
  const tessellation = perExportTessellation ?? clientTessellation;

  // Direct kernel export
  if (kernel.entry.exportFormats?.includes(targetFormat)) {
    return kernel.definition.exportGeometry(
      { format: targetFormat, tessellation, nativeHandle, options: formatOptions },
      runtime,
      kernel.ctx,
    );
  }

  // Find matching routes from the manifest
  const routes = this.manifest.exportRoutes.filter(
    (r) => r.kernelId === kernel.entry.id && r.targetFormat === targetFormat && r.transcoderId,
  );

  for (const route of routes) {
    const transcoder = transcoderRegistry.get(route.transcoderId!);

    const canProceed = await transcoder.definition.canTranscode(
      { from: route.sourceFormat, to: targetFormat, files: [] },
      transcoder.runtime,
      transcoder.ctx,
    );
    if (!canProceed) continue;

    const sourceResult = await kernel.definition.exportGeometry(
      { format: route.sourceFormat, tessellation, nativeHandle, options: {} },
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
          `Native formats: ${(kernel.entry.exportFormats ?? []).join(', ')}. ` +
          `Register a transcoder that supports this conversion.`,
        type: 'runtime',
        severity: 'error',
      },
    ],
  };
}
```

### Tessellation resolution chain

1. Per-export: `client.export('stl', { tessellation: { linearTolerance: 0.01 } })`
2. Client-level: `createRuntimeClient({ tessellation: { export: { linearTolerance: 0.01 } } })`
3. Kernel built-in default (when neither is provided)

The framework extracts `tessellation` from the options object before dispatching. Both the kernel first-leg export and the final output use the same tessellation quality — there is no separate tessellation for intermediate formats in single-hop.

## Middleware Interaction with Routed Exports

Middleware wraps the **entire export operation** — the outer boundary. It sees:

- **Input**: `format` set to the target format the consumer requested (e.g. `'usdz'`)
- **Output**: the final exported files (whether from direct kernel or routed through transcoder)

The internal kernel-export-then-transcode execution is framework-internal and does NOT re-enter the middleware chain. Middleware wraps the whole operation as a single unit:

- Logging middleware captures the full export operation
- Cache middleware can cache based on `targetFormat + dependencyHash`
- The intermediate format production is an implementation detail invisible to middleware

`KernelWorker.exportGeometry()` composes the middleware chain around `onExportGeometry()`. The route planner runs inside `onExportGeometry()`.

## Protocol Wire Format

All protocol types live in `packages/runtime/src/types/runtime-protocol.types.ts`.

### Export command — `RuntimeCommand`

```typescript
| { type: 'export'; requestId: string; format: string; options?: Record<string, unknown> }
```

- `format` is `string` (not `ExportFormat`) to support transcoder-routed formats outside the static union
- `options` carries format-specific configuration and `tessellation` (previously a top-level field, now unified under `options.tessellation`)

### Initialize command — `RuntimeCommand`

```typescript
| {
    type: 'initialize';
    requestId: string;
    options: Record<string, unknown>;
    middlewareEntries: MiddlewareRegistrations;
    bundlerEntries?: BundlerRegistrations;
    transcoderModules?: TranscoderModuleEntry[];
    fileSystemPort?: MessagePort;
    signalBuffer?: SharedArrayBuffer;
    geometryPoolBuffer?: SharedArrayBuffer;
    filePoolBuffer?: SharedArrayBuffer;
  }
```

```typescript
type TranscoderModuleEntry = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
};
```

`transcoderModules` is the new field. It mirrors how `middlewareEntries` and `bundlerEntries` pass plugin module references to the worker.

### Initialized response — `RuntimeResponse`

```typescript
| { type: 'initialized'; requestId: string; capabilities: CapabilitiesManifest }
```

`capabilities` is a new field. The manifest is included in the initialized response so the client has capabilities immediately after connection.

### Exported response — `RuntimeResponse`

```typescript
| {
    type: 'exported';
    requestId: string;
    result: ExportGeometryResult;
    route?: { routeId: string; sourceFormat: string; transcoderId: string };
  }
```

`route` is optional metadata for observability — records which route was used for the export.

### `ExportGeometryInput` — internal kernel input type

```typescript
type ExportGeometryInput<NativeHandle = unknown> = {
  format: string;
  tessellation?: Tessellation;
  nativeHandle: NativeHandle;
  options?: Record<string, unknown>;
};
```

Migration from current type:

| Field      | Change                                                                       |
| ---------- | ---------------------------------------------------------------------------- |
| `fileType` | Renamed to `format` for naming consistency with protocol and client API      |
| `format`   | Widened from `ExportFormat` to `string` to support transcoder-routed formats |
| `options`  | New field for format-specific export configuration                           |

## Import-for-Rendering: Tau Kernel

### Import-for-rendering flow

When a user opens `model.step` in Tau:

1. Kernel selection: `tau.canHandle({ extension: 'step' })` → `true` (Tau kernel's `extensions` includes `'step'` via `supportedImportFormats`)
2. `tau.createGeometry()` → reads file bytes → calls `importToGlb()` → returns `{ geometry: [{ format: 'gltf', content: glbData }], nativeHandle: glbData }`
3. Renderer displays the GLB geometry
4. On export: the route planner handles format routing (see below)

### Why this stays in the Tau kernel

Import-for-rendering is **kernel geometry evaluation** — it produces a `nativeHandle` and renderable geometry. This is the textbook `defineKernel` contract. A transcoder cannot do this: transcoders convert files but do not produce native handles or renderable geometry.

The Tau kernel continues to:

- Internally depend on `@taucad/converter` for `importToGlb` (kernel implementation detail)
- Return GLB as its native handle and renderable geometry

### Tau kernel `exportGeometry`

The Tau kernel only exports its native format (GLB/glTF). Format conversion is handled by transcoder plugins:

```typescript
// tau.kernel.ts
export default defineKernel({
  name: 'TauKernel',
  version: '2.0.0',

  // initialize, getDependencies, getParameters, createGeometry — no changes

  async exportGeometry({ format, nativeHandle }, { logger }) {
    if ((nativeHandle as Uint8Array).length === 0) {
      return createKernelError([
        {
          message: 'No geometry available for export. Render a file before exporting.',
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }

    if (format === 'glb' || format === 'gltf') {
      logger.log('Exporting geometry', { data: { format } });
      return createKernelSuccess([
        {
          name: `model.${format}`,
          bytes: nativeHandle as Uint8Array,
          mimeType: format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json',
        },
      ]);
    }

    return createKernelError([
      {
        message:
          `Tau kernel only natively exports glb/gltf. Format "${format}" requires ` +
          'a transcoder. Register converterTranscoder() to enable format conversion.',
        type: 'runtime',
        severity: 'error',
      },
    ]);
  },
});
```

### Tau plugin registration

```typescript
// tau.plugin.ts
import { supportedImportFormats } from '@taucad/converter/formats';
import { createKernelPlugin } from '#plugins/plugin-helpers.js';

export const tau = createKernelPlugin({
  id: 'tau',
  moduleUrl: new URL('tau.kernel.js', import.meta.url).href,
  extensions: [...supportedImportFormats],
  exportFormats: ['glb', 'gltf'] as const,
});
```

### Export flow for a file viewed via Tau kernel

When a user views `model.step` and exports to STL:

1. `client.export('stl')` sent to worker
2. Route planner: Tau kernel's `exportFormats` does not include `'stl'`
3. Look up routes: `converter` transcoder has edge `glb → stl`
4. Execute: `tau.exportGeometry({ format: 'glb' })` → GLB bytes → `converter.transcode({ from: 'glb', to: 'stl', files })` → STL bytes
5. Return STL to consumer

## Converter Transcoder Implementation

### Plugin registration

```typescript
// transcoders/converter/converter.plugin.ts
import { createTranscoderPlugin } from '#plugins/plugin-helpers.js';

export const converterTranscoder = createTranscoderPlugin({
  id: 'converter',
  moduleUrl: new URL('converter.transcoder.js', import.meta.url).href,
});
```

### Worker module

```typescript
// transcoders/converter/converter.transcoder.ts
import { exportFromGlb } from '@taucad/converter';
import { supportedExportFormats } from '@taucad/converter/formats';
import type { SupportedExportFormat } from '@taucad/converter/formats';
import { defineTranscoder } from '#types/runtime-transcoder.types.js';

export default defineTranscoder({
  name: 'ConverterTranscoder',
  version: '1.0.0',

  async initialize() {
    return {};
  },

  async discoverEdges() {
    return supportedExportFormats
      .filter((fmt) => fmt !== 'glb')
      .map((to) => ({
        from: 'glb',
        to,
        fidelity: 'mesh' as const,
      }));
  },

  async canTranscode({ from, to }) {
    return from === 'glb' && supportedExportFormats.includes(to as SupportedExportFormat);
  },

  async transcode({ files, to }, _runtime) {
    const primaryFile = files[0];
    if (!primaryFile) {
      return {
        success: false,
        issues: [{ message: 'No input file provided for conversion', type: 'runtime', severity: 'error' }],
      };
    }

    const exported = await exportFromGlb(primaryFile.bytes, to as SupportedExportFormat);
    return { success: true, data: exported, issues: [] };
  },

  async cleanup() {},
});
```

### Barrel

```typescript
// plugins/transcoder-factories.ts
export { converterTranscoder } from '#transcoders/converter/converter.plugin.js';
```

### Converter isolation guarantees

- `@taucad/converter` is not imported anywhere in `packages/runtime/src/framework/`
- `@taucad/converter` is imported only in plugin modules (`tau.kernel.ts`, `converter.transcoder.ts`)
- Users who do not register `converterTranscoder()` incur no converter dependency
- The runtime core is converter-agnostic

## Format Unification

### Remove variant format types

`libs/types/src/constants/file.constants.ts` currently includes `'stl-binary'` and `'step-assembly'` as separate format entries. These become schema options instead:

```typescript
export const exportFormats = ['stl', 'step', 'glb', 'gltf', '3mf'] as const;
```

### Variants become schema options

Binary and assembly mode are now Zod schema options declared by kernel modules:

```typescript
// replicad.kernel.ts (named export)
export const exportSchemas = {
  stl: z.object({
    binary: z.boolean().default(true).describe('Binary STL format'),
  }),
  step: z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single').describe('Assembly mode'),
  }),
};
```

### `fileExtensionFromExportFormat` update

Remove `'stl-binary'` and `'step-assembly'` keys. The remaining map is 1:1 with no duplicate extensions.

## Schema-Driven Export Configuration

### Zod for authoring, JSON Schema for interop

All export option schemas are authored in Zod inside kernel modules and transcoder modules. The worker converts them to JSON Schema during startup discovery via `zodToJsonSchema`. The main thread never imports Zod. JSON Schema is the only schema format that crosses the postMessage boundary.

### Schema layers

**Layer 1: Universal options** — defined by the framework, applied to all exports:

```typescript
// Framework-owned, defined in kernel-worker.ts
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

**Layer 2: Format-specific options** — declared by kernel module `exportSchemas` named export:

```typescript
// replicad.kernel.ts
export const exportSchemas = {
  stl: z.object({
    binary: z.boolean().default(true).describe('Binary STL format'),
  }),
  step: z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single').describe('Assembly mode'),
  }),
  glb: z.object({
    compression: z.enum(['none', 'draco', 'meshopt']).default('none').describe('Compression'),
  }),
  gltf: z.object({
    compression: z.enum(['none', 'draco', 'meshopt']).default('none').describe('Compression'),
  }),
};
```

### Worker conversion

During initialization, the worker:

1. Reads `exportSchemas` from each loaded kernel module
2. Converts each Zod schema to JSON Schema via `zodToJsonSchema()`
3. Extracts defaults via `schema.parse({})` (relying on `.default()` values)
4. Stores them in `ExportFormatCapability` entries in the manifest

### UI consumption

The UI reads from `CapabilitiesManifest.kernelExports`. For a selected format, it merges:

- Universal export JSON Schema (known statically in the UI)
- Format-specific JSON Schema from `manifest.kernelExports.find(e => e.format === selected)?.schema`

This produces the full RJSF form. The `ExportSettings` component reuses `rjsf-theme.tsx`, `FieldTemplate`, `ModifiedIndicator`, and delta-extraction patterns from the parameter editor.

```typescript
type ExportSettingsProps = {
  format: string;
  schema: RJSFSchema;
  defaults: Record<string, unknown>;
  values: Record<string, unknown>;
  onValuesChange: (values: Record<string, unknown>) => void;
};
```

## Per-CU Export in the Autonomous Topology

Each `RuntimeClient` owns a single compilation unit. Export operates on the last-rendered geometry's native handle. There is no `compilationUnit` parameter on `client.export()`.

Multi-CU export is orchestrated by the UI. The chat-converter panel renders a CU selector (checkbox list of entry files with geometry) and exports each selected CU independently:

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

## Dynamic Format Discovery for UI Consumers

The capabilities manifest is the sole source of truth for available formats. UI components derive format lists from `manifest.exportRoutes`:

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
        direct: !route.transcoderId,
      });
    }
  }

  return [...formatMap.entries()].map(([format, meta]) => ({ format, ...meta }));
}, [capabilities]);
```

Static format lists in UI components (e.g., hardcoded `ExportFormat[]` arrays) are replaced by manifest-derived lists. `@taucad/types` continues providing format display metadata (file extensions, MIME types).

### Exception: Standalone converter route

The `/converter` route (`apps/ui/app/routes/converter/`) is a standalone product. It directly consumes `@taucad/converter` without going through the runtime — this is the only acceptable direct consumer outside of plugin modules.

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
4. On export: merge persisted `formatOptions[format]` with per-export overrides

## Consumer Code Examples

### Plugin author: defining a transcoder

```typescript
// transcoders/my-cloud/my-cloud.transcoder.ts
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
    return { client: await createApiClient(options.apiKey, options.endpoint) };
  },

  async discoverEdges(_runtime, context) {
    const matrix = await context.client.getConversionMatrix();
    return matrix.map((entry) => ({
      from: entry.inputFormat,
      to: entry.outputFormat,
      fidelity: entry.preservesBRep ? ('brep' as const) : ('mesh' as const),
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

### Plugin author: registering a transcoder factory (co-located)

```typescript
// transcoders/my-cloud/my-cloud.plugin.ts
import { createTranscoderPlugin } from '#plugins/plugin-helpers.js';

type MyCloudOptions = { apiKey: string; endpoint?: string };

export const myCloudTranscoder = createTranscoderPlugin<MyCloudOptions>({
  id: 'my-cloud',
  moduleUrl: new URL('my-cloud.transcoder.js', import.meta.url).href,
});
```

### Consumer: creating a runtime client with transcoders

```typescript
import { createRuntimeClient } from '@taucad/runtime';
import { replicad, tau } from '@taucad/runtime/kernel';
import { converterTranscoder } from '@taucad/runtime/transcoder';
import { esbuild } from '@taucad/runtime/bundler';
import { parameterCache, geometryCache } from '@taucad/runtime/middleware';

const client = createRuntimeClient({
  kernels: [replicad(), tau()],
  transcoders: [converterTranscoder()],
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
  console.log(
    'Available export formats:',
    manifest.exportRoutes.map((r) => r.targetFormat),
  );
});

// Render a file
await client.render({ file: '/src/model.ts', parameters: { width: 50 } });

// Export — direct kernel route (replicad supports STEP natively)
const stepResult = await client.export('step', { assemblyMode: 'assembly' });

// Export — routed via converter (replicad → GLB → converter → USDZ)
const usdzResult = await client.export('usdz');
```

### Consumer: viewing a foreign CAD file

```typescript
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

### Consumer: zero-config with preset

```typescript
import { createRuntimeClient, presets } from '@taucad/runtime';

const client = createRuntimeClient(presets.all());
// presets.all() includes converterTranscoder() — all format conversions available out of the box
```

## File Inventory: New and Modified

### New files

| Path                                                                 | Purpose                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/types/runtime-transcoder.types.ts`             | `TranscoderDefinition`, `TranscoderEdge`, `TranscodeInput`, `TranscodeResult`, `TranscoderRuntime`, `defineTranscoder` |
| `packages/runtime/src/transcoders/converter/converter.transcoder.ts` | `defineTranscoder` implementation wrapping `@taucad/converter`                                                         |
| `packages/runtime/src/transcoders/converter/converter.plugin.ts`     | `createTranscoderPlugin` factory for converter                                                                         |
| `packages/runtime/src/plugins/transcoder-factories.ts`               | Barrel re-export of transcoder plugin factories                                                                        |

### Modified files

| Path                                                          | Change                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/plugins/plugin-types.ts`                | Add `TranscoderPlugin` type; add `exportFormats` to `KernelPlugin`                                                                                                                                  |
| `packages/runtime/src/plugins/plugin-helpers.ts`              | Add `createTranscoderPlugin` factory function                                                                                                                                                       |
| `packages/runtime/src/plugins/presets.ts`                     | Import `converterTranscoder`; add to `presets.all()`                                                                                                                                                |
| `packages/runtime/src/client/runtime-client.ts`               | Add `transcoders` to options; add `capabilities` property; add `'capabilities'` event; widen `export()` format type; change export options signature                                                |
| `packages/runtime/src/client/runtime-client-options.ts`       | Add `'transcoders'` to `pluginArrayKeys`                                                                                                                                                            |
| `packages/runtime/src/types/runtime-kernel.types.ts`          | Rename `ExportGeometryInput.fileType` → `.format`; widen to `string`; add `.options`                                                                                                                |
| `packages/runtime/src/types/runtime-protocol.types.ts`        | Add `transcoderModules` to initialize command; widen export format to `string`; replace `tessellation` with `options`; add `capabilities` to initialized response; add `route` to exported response |
| `packages/runtime/src/types/runtime.types.ts`                 | Add `CapabilitiesManifest`, `ExportFormatCapability`, `TranscodeEdgeCapability`, `ExportRoute`                                                                                                      |
| `packages/runtime/src/framework/kernel-worker.ts`             | Add transcoder loading, discovery, route planning, export routing in `exportGeometry`                                                                                                               |
| `packages/runtime/src/framework/kernel-runtime-worker.ts`     | Pass `transcoderModules` to base worker; update `onExportGeometry` to use route planner                                                                                                             |
| `packages/runtime/src/framework/runtime-worker-client.ts`     | Update `exportGeometry` to send `options` instead of `tessellation`; handle `capabilities` from initialized                                                                                         |
| `packages/runtime/src/framework/runtime-worker-dispatcher.ts` | Forward `transcoderModules` in initialize; forward `options` in export                                                                                                                              |
| `packages/runtime/src/kernels/tau/tau.kernel.ts`              | Simplify `exportGeometry` to only GLB/glTF                                                                                                                                                          |
| `packages/runtime/src/kernels/tau/tau.plugin.ts`              | Add `exportFormats: ['glb', 'gltf']`                                                                                                                                                                |
| `packages/runtime/src/kernels/replicad/replicad.plugin.ts`    | Add `exportFormats: ['stl', 'step', 'glb', 'gltf']`                                                                                                                                                 |
| `packages/runtime/src/kernels/*/[name].plugin.ts`             | Add `exportFormats` to each kernel plugin                                                                                                                                                           |
| `packages/runtime/src/index.ts`                               | Export `TranscoderPlugin`, `createTranscoderPlugin`, `defineTranscoder`                                                                                                                             |
| `packages/runtime/package.json`                               | Add `./transcoder` subpath export                                                                                                                                                                   |
| `libs/types/src/constants/file.constants.ts`                  | Remove `'stl-binary'`, `'step-assembly'` from `exportFormats`                                                                                                                                       |

## Migration Plan

### Phase 1: Plugin primitives and types

**Goal**: All new types and factory functions exist. Nothing uses them yet.

1. Create `packages/runtime/src/types/runtime-transcoder.types.ts` with all transcoder types
2. Add `TranscoderPlugin` to `plugin-types.ts`
3. Add `exportFormats` to `KernelPlugin`
4. Add `createTranscoderPlugin` to `plugin-helpers.ts`
5. Add `transcoders` to `RuntimeClientOptions`
6. Add `'transcoders'` to `pluginArrayKeys` in `runtime-client-options.ts`
7. Create empty `plugins/transcoder-factories.ts` barrel
8. Add `./transcoder` subpath export to `package.json`
9. Export new types from `index.ts`

### Phase 2: Manifest and discovery

**Goal**: Worker loads transcoders, discovers capabilities, emits manifest.

1. Add `transcoderModules` to `initialize` command in protocol types
2. Add `CapabilitiesManifest` types to `runtime.types.ts`
3. Add `capabilities` to `initialized` response
4. Update `KernelWorker` to load transcoder modules during initialization
5. Implement Zod → JSON Schema conversion for kernel `exportSchemas`
6. Implement `discoverEdges()` calling and edge schema conversion
7. Implement route computation
8. Emit manifest in `initialized` response
9. Add `capabilities` property and event to `RuntimeClient`
10. Forward `transcoderModules` through dispatcher

### Phase 3: Export protocol and route planner

**Goal**: `client.export()` supports format options and routes through transcoders.

1. Rename `ExportGeometryInput.fileType` → `.format`; widen to `string`; add `.options`
2. Update export command: replace `tessellation` with `options`; widen `format` to `string`
3. Update `RuntimeWorkerClient.exportGeometry` to send `options`
4. Implement `executeExport` with single-hop route planner in `KernelWorker`
5. Add `route` metadata to `exported` response
6. Update `RuntimeClient.export()` to pass `options` to worker
7. Update all existing kernel `exportGeometry` implementations for `format` (was `fileType`)

### Phase 4: Converter transcoder extraction

**Goal**: Converter is a plugin. Tau kernel only exports GLB/glTF.

1. Create `transcoders/converter/converter.transcoder.ts`
2. Create `transcoders/converter/converter.plugin.ts`
3. Add `converterTranscoder` to `transcoder-factories.ts` barrel
4. Add `converterTranscoder()` to `presets.all()`
5. Refactor `tau.kernel.ts` `exportGeometry` to only export GLB/glTF
6. Update `tau.plugin.ts` with `exportFormats: ['glb', 'gltf']`
7. Add `exportFormats` to all other kernel plugins
8. Verify import-for-rendering still works unchanged

### Phase 5: Format unification

**Goal**: `stl-binary` and `step-assembly` removed; replaced by schema options.

1. Remove `'stl-binary'`, `'step-assembly'` from `exportFormats` constant
2. Remove entries from `fileExtensionFromExportFormat`
3. Add `exportSchemas` named exports to kernel modules (replicad, opencascade, etc.)
4. Update all consumers that reference removed format variants

### Phase 6: UI and hooks consolidation

**Goal**: All export UIs use `RuntimeClient.export()` with dynamic format list from manifest.

1. Refactor chat-converter panel to derive formats from `capabilities.exportRoutes`
2. Build `ExportSettings` RJSF component using manifest schemas
3. Migrate `use-ar.ts` to `RuntimeClient.export('usdz')`
4. Deprecate `useGeometryExport` in `@taucad/react`
5. Remove command palette export items; single "Open Exporter" command

### Phase 7: Preference persistence and cleanup

**Goal**: Export preferences persist; converter deps removed from UI/react.

1. Implement `.tau/export/preferences.json` in project machine
2. Remove `@taucad/converter` from `apps/ui` and `packages/react` `package.json`

## Recommendations

| #   | Action                                                                              | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `TranscoderPlugin`, `TranscoderDefinition`, `TranscoderRuntime` types           | P0       | Medium | High   |
| R2  | Add `createTranscoderPlugin()` factory and `defineTranscoder()` helper              | P0       | Low    | High   |
| R3  | Add `exportFormats` to `KernelPlugin` type                                          | P0       | Low    | High   |
| R4  | Extend worker initialization to load transcoders and emit `CapabilitiesManifest`    | P0       | Medium | High   |
| R5  | Implement minimum-viable single-hop route planner                                   | P0       | Medium | High   |
| R6  | Implement `converterTranscoder` wrapping `@taucad/converter`                        | P0       | Medium | High   |
| R7  | Refactor Tau kernel to only natively export GLB/glTF                                | P0       | Low    | High   |
| R8  | Add `options` to export protocol; rename `ExportGeometryInput.fileType` → `.format` | P0       | Low    | High   |
| R9  | Add `transcoders` to `RuntimeClientOptions` and `presets.all()`                     | P0       | Low    | High   |
| R10 | Add `exportFormats` to all existing kernel plugins                                  | P0       | Low    | High   |
| R11 | Remove `'stl-binary'`, `'step-assembly'` from `ExportFormat`                        | P1       | Medium | High   |
| R12 | Build `ExportSettings` RJSF component using manifest schemas                        | P1       | Medium | High   |
| R13 | Migrate chat-converter, AR, `@taucad/react` hooks to runtime export                 | P1       | Medium | High   |
| R14 | Expose route metadata in `exported` response                                        | P1       | Low    | Medium |
| R15 | Implement export preference persistence under `.tau/export/`                        | P2       | Medium | Medium |
| R16 | Remove `@taucad/converter` from `apps/ui` and `@taucad/react` deps                  | P2       | Low    | Medium |

## Appendix

### A. Naming Alignment

| Concept          | Plugin Registration | Worker Module           | Manifest                      | Client API             | Protocol Command       | Kernel Input         |
| ---------------- | ------------------- | ----------------------- | ----------------------------- | ---------------------- | ---------------------- | -------------------- |
| Target format    | `exportFormats`     | `exportSchemas[fmt]`    | `exportRoutes[].targetFormat` | `export(format)`       | `command.format`       | `input.format`       |
| Source format    | —                   | —                       | `exportRoutes[].sourceFormat` | —                      | `route.sourceFormat`   | —                    |
| Schema authoring | —                   | Zod (kernel/transcoder) | —                             | —                      | —                      | —                    |
| Schema interop   | —                   | —                       | JSON Schema                   | RJSF                   | —                      | —                    |
| Options          | `plugin.options`    | `optionsSchema`         | `defaults`                    | `export(f, options)`   | `command.options`      | `input.options`      |
| Tessellation     | —                   | —                       | (in universal schema)         | `options.tessellation` | `options.tessellation` | `input.tessellation` |
| Fidelity         | —                   | —                       | `fidelity`                    | —                      | —                      | —                    |

### B. Plugin Registration Summary

| Plugin Type | Registration Type  | Factory Helper           | Define Helper      | Worker Contract        | File Pattern                                       |
| ----------- | ------------------ | ------------------------ | ------------------ | ---------------------- | -------------------------------------------------- |
| Kernel      | `KernelPlugin`     | `createKernelPlugin`     | `defineKernel`     | `KernelDefinition`     | `kernels/<name>/<name>.{kernel,plugin}.ts`         |
| Transcoder  | `TranscoderPlugin` | `createTranscoderPlugin` | `defineTranscoder` | `TranscoderDefinition` | `transcoders/<name>/<name>.{transcoder,plugin}.ts` |
| Middleware  | `MiddlewarePlugin` | `createMiddlewarePlugin` | `defineMiddleware` | `MiddlewareDefinition` | `middleware/<name>.middleware.ts`                  |
| Bundler     | `BundlerPlugin`    | `createBundlerPlugin`    | `defineBundler`    | `BundlerDefinition`    | `bundlers/<name>.bundler.ts`                       |

### C. Per-Kernel Export Format Matrix

| Kernel          | `exportFormats`                  | Fidelity                   | Notes                      |
| --------------- | -------------------------------- | -------------------------- | -------------------------- |
| Replicad        | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) | Primary CAD kernel         |
| OpenCascade     | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) | Direct OCCT API            |
| Manifold        | `['glb', 'gltf']`                | mesh                       | Mesh-only kernel           |
| OpenSCAD        | `['stl', 'glb', 'gltf', '3mf']`  | mesh                       | CSG kernel                 |
| JSCAD           | `['glb', 'gltf']`                | mesh                       | Mesh-only kernel           |
| Zoo (KCL)       | `['stl', 'step', 'glb', 'gltf']` | brep (step), mesh (others) | Cloud kernel via WebSocket |
| Tau (converter) | `['glb', 'gltf']`                | mesh                       | Foreign file import viewer |

### D. Export Options Schema per Format

| Format       | Option                          | Zod Type                               | Default        |
| ------------ | ------------------------------- | -------------------------------------- | -------------- |
| **All**      | `tessellation.linearTolerance`  | `z.number().min(0.001).max(10)`        | `0.01`         |
| **All**      | `tessellation.angularTolerance` | `z.number().min(1).max(90)`            | `30`           |
| **All**      | `coordinateSystem`              | `z.enum(['y-up', 'z-up']).optional()`  | Format default |
| **stl**      | `binary`                        | `z.boolean()`                          | `true`         |
| **step**     | `assemblyMode`                  | `z.enum(['single', 'assembly'])`       | `'single'`     |
| **glb/gltf** | `compression`                   | `z.enum(['none', 'draco', 'meshopt'])` | `'none'`       |
| **3mf**      | `units`                         | `z.enum(['millimeter', 'inch'])`       | `'millimeter'` |

### E. Compatibility Posture

This architecture is a forward rollout with no public compatibility guarantees required. `@taucad/runtime` is consumed as source — there are no published artifacts to maintain backward compatibility with. API and protocol renames prioritize conceptual correctness.

### F. Vision Policy Alignment

Per `docs/policy/vision-policy.md` — "Everything is pluggable. The `defineKernel()` pattern scales to any engineering domain." The `defineTranscoder()` pattern extends this principle to format conversion, maintaining the same factory + define + plugin architecture. Future engineering domains (ECAD, FEA, simulation) will produce their own geometry formats — the pluggable transcoder model ensures format conversion scales with the platform without hardcoding intermediate representations.
