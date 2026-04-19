---
title: 'Export Pipeline v2'
description: 'Consolidated architecture for a unified, type-safe, schema-driven export pipeline in the runtime with kernel-first export, converter fallback, worker-side capability discovery (Zod → JSON Schema on worker startup), and format-specific configuration'
status: superseded
superseded_by: docs/research/export-pipeline-v3.md
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/unified-export-pipeline-architecture.md
  - docs/research/schema-driven-export-configuration.md
  - docs/research/converter-runtime-consolidation.md
  - docs/policy/library-api-policy.md
  - docs/research/parameter-architecture-v2.md
---

# Export Pipeline v2

Consolidated architecture for unifying all export paths into the runtime kernel pipeline — with full type safety through the plugin layer, schema-driven format-specific configuration (Zod schemas authored in kernel modules, converted to JSON Schema by the worker during startup), autonomous capability discovery, and per-CU export through the existing one-client-per-CU topology.

This document supersedes and consolidates the findings from `unified-export-pipeline-architecture.md`, `schema-driven-export-configuration.md`, and `converter-runtime-consolidation.md`, incorporating critical design refinements.

## Executive Summary

The export system today has two parallel pipelines (kernel worker vs main-thread converter), incompatible format type systems, no user-configurable options beyond format selection, and zero type safety through the plugin boundary. This document designs an export pipeline where: (1) kernels declare their export formats on the plugin (serializable string array for compile-time type safety) and their export option schemas as Zod co-exports in the kernel module (worker-only, converted to JSON Schema during worker startup); (2) the worker discovers all capabilities at initialization and emits them as a JSON Schema manifest in the `initialized` response; (3) consumers get type-safe `client.export()` calls constrained to the formats their registered plugins declare; (4) when a kernel lacks native export for a format, the framework produces a correctly-tessellated intermediate GLB and converts it via `exportFromGlb` internally — not as a new "exporter provider" abstraction, but as a framework-level fallback using the existing converter; (5) all export configuration (tessellation, compression, coordinate system) is schema-driven — authored in Zod in kernel modules, converted to JSON Schema by the worker for RJSF form generation; (6) user export preferences persist under `.tau/export/`.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architectural Critique: Why Not a First-Class Exporter Provider](#architectural-critique-why-not-a-first-class-exporter-provider)
- [Corrected Mental Model](#corrected-mental-model)
- [Type-Safe Plugin Architecture](#type-safe-plugin-architecture)
- [Capability Discovery via Initialization](#capability-discovery-via-initialization)
- [Format Unification: Options Not Types](#format-unification-options-not-types)
- [Schema-Driven Export Configuration](#schema-driven-export-configuration)
- [Fallback Export: Tessellation Consistency](#fallback-export-tessellation-consistency)
- [Per-CU Export in the Autonomous Topology](#per-cu-export-in-the-autonomous-topology)
- [Dynamic Format Discovery for UI Consumers](#dynamic-format-discovery-for-ui-consumers)
- [Export Preference Persistence](#export-preference-persistence)
- [Converter Consolidation](#converter-consolidation)
- [Recommendations](#recommendations)

## Problem Statement

The previous three research documents identified 8 findings across the export landscape. This consolidated document addresses those findings plus 11 refinement items:

1. Each `RuntimeClient` owns a single CU — multi-CU export is a UI-layer concern, not a runtime API concern
2. Tessellation belongs in the export options schema, not as a standalone parameter
3. The "quality" taxonomy ("native"/"mesh"/"service") uses poor terminology — replaced with `fidelity` (`'brep'` | `'mesh'`)
4. `stl-binary` and `step-assembly` are removed from `ExportFormat`; binary and assembly mode become schema-driven options on their respective formats
5. Fallback GLB must be tessellated consistently with the consumer's expectations
6. Adding a first-class "exporter provider" to the runtime framework is architecturally suspect — critically evaluated below
7. Plugin generics flow end-to-end for type-safe `client.export()` calls
8. All schemas are authored in Zod in kernel modules (worker-only), converted to JSON Schema by the worker during startup
9. Capability discovery happens at initialization, not on-demand
10. Export preferences persist under `.tau/`
11. Format metadata is dynamically derived from capabilities, not statically imported

## Architectural Critique: Why Not a First-Class Exporter Provider

The earlier research proposed `defineExporterProvider` as a new runtime framework primitive — an `ExporterProvider` interface that sits alongside `KernelPlugin`, `MiddlewarePlugin`, and `BundlerPlugin`. This deserves adversarial review against library-api-policy.

### The converter serves two roles today

1. **Import kernel**: The Tau kernel uses `importToGlb` to import STEP, STL, 3DM, DRC, and other foreign file formats into GLB — effectively acting as a "universal importer" kernel.
2. **Export fallback**: When a kernel (e.g., Manifold) cannot natively export to a requested format (e.g., STL), the converter's `exportFromGlb` provides mesh-based fallback.

### Why a new `ExporterProvider` abstraction is wrong

**1. It's a second export pipeline, not a consolidation.** The whole point of this work is to eliminate the two-pipeline fragmentation. Adding `ExporterProvider` creates a formal third abstraction (`KernelDefinition.exportGeometry` + `ExporterProvider.exportFromGlb` + raw converter). The export resolution router would need to orchestrate between kernel-native and provider-fallback paths, adding framework complexity.

**2. It violates the consistency principle (library-api-policy §4).** Every existing contract interface (`KernelDefinition`, `MiddlewareDefinition`, `BundlerDefinition`) follows the same `(input, runtime, context)` pattern. `ExporterProvider` would need a different signature (`(glbData, format, options)` — no runtime, no context, different input shape). This breaks the consistency principle: a developer who learns one plugin interface cannot predict the shape of `ExporterProvider`.

**3. Kernels already ARE the export mechanism.** `KernelDefinition.exportGeometry` is a required method. Every kernel implements it. The correct architecture is to make the fallback path a **framework-level concern** that uses `exportFromGlb` directly when no kernel can natively export the requested format.

**4. Commercial exporters (Zoo API) are kernels, not providers.** The Zoo kernel already has `exportGeometry` that calls `utilities.exportFromMemory`. A future scenario where Zoo provides STEP export as a service is handled by the Zoo kernel's own `exportGeometry`, not by a separate `ExporterProvider` that wraps the Zoo API. The kernel IS the provider.

**5. Middleware already handles cross-cutting export concerns.** Format convention enforcement (coordinate systems, units) belongs in `wrapExportGeometry` middleware, not in an `ExporterProvider` wrapper. The middleware onion model is the established interception pattern.

### The correct architecture

When a kernel lacks native export for a requested format, the framework calls the kernel's `exportGeometry` with `format: 'glb'` to produce an export-quality intermediate, then calls `exportFromGlb` from `@taucad/converter` directly. This is an internal framework fallback — no new abstraction, no second kernel lifecycle, no additional plugin interface. The middleware chain wraps the outer export operation, so cross-cutting concerns (logging, tracing) still apply.

Future commercial fallbacks (e.g., Zoo as a better STEP-from-mesh service) are handled by registering a kernel plugin that has broader `exportFormats` in its capabilities, and the framework routes to it when the primary kernel cannot handle the format.

## Corrected Mental Model

```
┌──────────────────────────────────────────────────────┐
│ UI Layer                                             │
│ ┌────────────────┐  ┌────────────────┐               │
│ │ Chat Exporter  │  │ AR Quick Look  │               │
│ │ Panel          │  │ (via export()) │               │
│ └───────┬────────┘  └───────┬────────┘               │
│         │                   │                        │
│ ┌───────▼───────────────────▼──────────┐             │
│ │ Per-CU RuntimeClient.export()        │             │
│ │ (one client per compilation unit)    │             │
│ └───────┬──────────────────────────────┘             │
├─────────┼────────────────────────────────────────────┤
│ Runtime │ (per-CU kernel worker)                     │
│ ┌───────▼──────────────────────────────┐             │
│ │ Middleware Onion (wrapExportGeometry) │             │
│ └───────┬──────────────────────────────┘             │
│ ┌───────▼──────────────────────────────┐             │
│ │ Framework Export Handler (innermost) │             │
│ │                                      │             │
│ │ if kernel supports format natively:  │             │
│ │   → kernel.exportGeometry(input)     │             │
│ │                                      │             │
│ │ else:                                │             │
│ │   → kernel.exportGeometry(glb)       │             │
│ │   → exportFromGlb(glbBytes, format)  │             │
│ │     (direct import from converter)   │             │
│ │                                      │             │
│ │ error if GLB also unsupported        │             │
│ └──────────────────────────────────────┘             │
└──────────────────────────────────────────────────────┘
```

No new plugin abstraction. The framework imports `exportFromGlb` from `@taucad/converter` as an internal dependency. Middleware handles cross-cutting concerns via the onion wrap. The fallback path is an implementation detail inside the framework's export handler.

## Type-Safe Plugin Architecture

### The Problem

Today, `KernelPlugin` is not generic — the factory `createKernelPlugin<ReplicadOptions>` constrains the factory's parameter type, but the returned `KernelPlugin` object erases all kernel-specific type information. `RuntimeClientOptions.kernels` is `KernelPlugin[]`, and `RuntimeClient.export()` accepts the full `ExportFormat` union regardless of which kernels are registered.

This means:

- `client.export('usdz')` compiles even when only `replicad()` is registered (runtime error)
- Export options are untyped — no format-specific autocomplete
- No compile-time guarantee that requested formats are available

### Design: Two-Layer Capability Declaration

Export capabilities are split across two layers, each carrying only the data its context needs:

**Main thread — `KernelPlugin`**: Carries `exportFormats` as a serializable string array. This is the only capability data the main thread needs — it drives compile-time type safety for `client.export()`. No Zod dependency on the main thread.

```typescript
type KernelPlugin<F extends readonly ExportFormat[] = readonly ExportFormat[]> = {
  id: string;
  moduleUrl: string;
  extensions: string[];
  detectImport?: RegExp;
  builtinModuleNames?: string[];
  options?: Record<string, unknown>;
  /** Export formats this kernel natively supports — drives compile-time type safety */
  exportFormats: F;
};
```

**Worker — kernel module exports**: The kernel module exports `exportSchemas` alongside its `defineKernel()` default export. Zod schemas live here and are only imported by the worker during its discovery phase.

```typescript
// Worker-side convention: kernel modules export Zod schemas for their export formats
type KernelExportSchemas = Partial<Record<ExportFormat, z.ZodType>>;
```

`exportFormats` is a **required** field on `KernelPlugin`. Every kernel declares what it can export, even if minimal (e.g., `['glb', 'gltf']` for mesh-only kernels).

### Design: Type-Safe Factory

The `createKernelPlugin` factory declares `exportFormats` inline — no capabilities import, no Zod dependency on the main thread:

```typescript
// kernel-factories.ts (main thread — no Zod import)
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('../kernels/replicad/replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  exportFormats: ['stl', 'step', 'glb', 'gltf'] as const,
});
```

Zod schemas are defined in the kernel module (or co-located file) and exported as a named export — only the worker imports them:

```typescript
// replicad.kernel.ts (worker-side — has Zod)
import { z } from 'zod';

export const exportSchemas = {
  step: z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single').describe('Assembly Mode'),
  }),
  stl: z.object({
    binary: z.boolean().default(true).describe('Binary STL'),
  }),
};

export default defineKernel({
  name: 'Replicad',
  version: '1.0.0',
  // ... kernel implementation
});
```

### Design: Type-Safe RuntimeClient

`createRuntimeClient` becomes generic over the plugin tuple, collecting format unions from each plugin's `exportFormats`:

```typescript
type CollectExportFormats<Plugins extends readonly KernelPlugin[]> = Plugins[number]['exportFormats'][number];

type RuntimeClientOptions<K extends readonly KernelPlugin[] = KernelPlugin[]> = {
  kernels: [...K];
  middleware?: MiddlewarePlugin[];
  bundlers?: BundlerPlugin[];
  // ... existing fields
};

function createRuntimeClient<K extends readonly KernelPlugin[]>(
  options: RuntimeClientOptions<K>,
): RuntimeClient<CollectExportFormats<K>>;
```

This means:

```typescript
const client = createRuntimeClient({
  kernels: [replicad(), manifold()],
});

// Type of client.export's format parameter:
// 'stl' | 'step' | 'glb' | 'gltf'  (from replicad)
// | 'glb' | 'gltf'                  (from manifold)
// = 'stl' | 'step' | 'glb' | 'gltf'

client.export('stl'); // ✓ compiles
client.export('usdz'); // ✗ compile error — no kernel supports usdz
```

When the Tau kernel is registered (which declares all converter formats in its `exportFormats`), the format parameter widens to the full union — the correct behavior, since Tau can export anything via `exportFromGlb`.

### Worker Boundary and Type Safety

The `postMessage` boundary serializes everything — generics cannot cross this gap. The type safety described above is a **compile-time** concern on the main thread (format unions from `exportFormats` arrays). At runtime, the worker owns all schema validation: it has the Zod schemas (from kernel module imports), validates export options against them, and returns actionable errors for unsupported formats or invalid options. The compile-time generics prevent those runtime errors in typed codebases.

## Capability Discovery via Initialization

### Autonomous Architecture Alignment

The autonomous kernel topology establishes that the worker is a self-scheduling reactive service. Capability discovery fits naturally into this model: the worker knows its full plugin set at initialization and emits a capabilities manifest as part of the `initialized` response.

### Two-Format Schema Model

Export option schemas exist in two representations with distinct roles:

| Format          | Role                          | Where it lives                                                             | Used for                                                                                  |
| --------------- | ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Zod**         | Authoring format (code layer) | Kernel module `exportSchemas` export (worker-only)                         | Type inference, defaults, descriptions, validation logic — better DX than raw JSON Schema |
| **JSON Schema** | Interop format (serializable) | `CapabilitiesManifest`, protocol messages, RJSF forms, `.tau/` persistence | Crosses `postMessage`, drives UI form rendering, stored on disk                           |

The conversion is one-way: Zod → JSON Schema via `zodToJsonSchema`. It happens on the **worker** during the startup discovery phase — after the worker dynamically imports each kernel module and reads its `exportSchemas` named export. The main thread never imports Zod schemas; it only receives the resulting JSON Schema in the `initialized` response.

```typescript
// Worker discovery phase (during initialization)
const kernelModule = await import(registration.moduleUrl);
const definition = kernelModule.default;
const exportSchemas = kernelModule.exportSchemas ?? {};

const jsonSchemas = Object.fromEntries(
  Object.entries(exportSchemas).map(([format, zodSchema]) => [format, zodToJsonSchema(zodSchema)]),
);
```

This keeps Zod as a worker-only dependency. The main thread's `KernelPlugin` carries only serializable data (`exportFormats` as a string array). All downstream consumers of schema data — the capabilities manifest, the UI, persistence — operate exclusively on JSON Schema.

### Design: Capabilities Manifest

Extend the `initialized` response with a capabilities manifest:

```typescript
type ExportFormatCapability = {
  /** Export format identifier */
  format: ExportFormat;
  /** Which kernel provides this format */
  kernelId: string;
  /** 'brep' for native BRep export (lossless), 'mesh' for tessellated export */
  fidelity: 'brep' | 'mesh';
  /** JSON Schema for format-specific export options — the serializable interop representation */
  schema: Record<string, unknown>;
  /** Default values for format-specific options (extracted from Zod .default() by the worker) */
  defaults: Record<string, unknown>;
};

type CapabilitiesManifest = {
  exportFormats: ExportFormatCapability[];
};

// Extended initialized response
| { type: 'initialized'; requestId: string; capabilities: CapabilitiesManifest }
```

### Client-Side Consumption

`RuntimeClient` stores the manifest and exposes it:

```typescript
type RuntimeClient = {
  // ... existing API

  /** Capabilities discovered at initialization. Available after connect(). */
  readonly capabilities: CapabilitiesManifest;

  /** Event emitted once after connect() when capabilities are known. */
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest) => void): () => void;
};
```

The `cad.machine` subscribes to `capabilities` and stores the manifest in context for UI consumption:

```typescript
cleanups.push(
  client.on('capabilities', (manifest: CapabilitiesManifest) => {
    machineRef.send({ type: 'capabilitiesDiscovered', manifest });
  }),
);
```

### Fidelity Taxonomy

The previous research used "quality" with values "native"/"mesh"/"service". Refined terminology:

| Value  | Meaning                                                                   | Example                                     |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------- |
| `brep` | Export from boundary representation — lossless, no tessellation artifacts | Replicad STEP via `shape.blobSTEP()`        |
| `mesh` | Export from tessellated mesh — lossy, controlled by tessellation options  | Any GLB-based export, Assimp STEP from mesh |

"Service" is not a fidelity level — it describes the execution location, not the geometry fidelity. A service-based export could produce either `brep` or `mesh` depending on the service's capabilities.

## Format Unification: Options Not Types

### Problem

`ExportFormat` includes variant types that encode configuration as separate formats:

- `'stl'` and `'stl-binary'` — binary is a property of STL export, not a separate format
- `'step'` and `'step-assembly'` — assembly mode is a property of STEP export, not a separate format

This conflation means the format union carries configuration that belongs in export options.

### Design

Remove variant formats from `ExportFormat`:

```typescript
// libs/types/src/constants/file.constants.ts
const exportFormats = ['stl', 'step', 'glb', 'gltf', '3mf'] as const;
```

Binary and assembly mode become Zod schema options on the format:

```typescript
const stlExportSchema = z.object({
  binary: z.boolean().default(true).describe('Binary STL'),
});

const stepExportSchema = z.object({
  assemblyMode: z.enum(['single', 'assembly']).default('single').describe('Assembly Mode'),
});
```

The kernel reads `input.options.binary` or `input.options.assemblyMode` to dispatch internally.

### Affected Constants

`fileExtensionFromExportFormat` in `libs/types` simplifies — no more duplicate mappings for `'stl-binary' → 'stl'` and `'step-assembly' → 'step'`:

```typescript
const fileExtensionFromExportFormat = {
  stl: 'stl',
  step: 'step',
  glb: 'glb',
  gltf: 'gltf',
  '3mf': '3mf',
} as const satisfies Record<ExportFormat, FileExtension>;
```

## Schema-Driven Export Configuration

### Zod for Authoring, JSON Schema for Interop

All export option schemas are authored in Zod inside kernel modules — providing type inference, `.default()` values, `.describe()` labels, and compile-time validation. The worker converts these to JSON Schema (via `zodToJsonSchema`) during the startup discovery phase. JSON Schema is then the canonical interop format emitted in the `initialized` response and consumed by the manifest, RJSF form rendering, and `.tau/` persistence. No manual JSON Schema authoring anywhere in the export pipeline — Zod is the single authoring surface, and it never leaves the worker.

### Schema Layers

Export configuration comes from two additive layers:

**Layer 1: Universal options** — applied to all exports:

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

**Layer 2: Format-specific options** — declared by the kernel module's `exportSchemas` export:

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

Middleware options (coordinate transform, edge detection) are configured at registration time via the existing `defineMiddleware` `optionsSchema` mechanism. No new schema layer needed.

### Tessellation Resolution

Tessellation has a three-level resolution chain:

1. Per-export options: `client.export('stl', { tessellation: { ... } })`
2. Client-level default: `createRuntimeClient({ tessellation: { export: { ... } } })`
3. Kernel built-in default (when neither is provided)

The framework extracts `tessellation` from the merged options before dispatching to the kernel:

```typescript
// Framework-level extraction (in KernelWorker.exportGeometry)
const { tessellation, ...formatOptions } = validatedOptions;
const resolvedTessellation = tessellation ?? clientOptions.tessellation?.export;

const kernelInput: ExportGeometryInput = {
  format,
  tessellation: resolvedTessellation,
  nativeHandle: this.nativeHandle,
  options: formatOptions,
};
```

The framework separates universal concerns (`tessellation`) from format-specific options (`formatOptions`). The kernel receives `input.tessellation` (universal, framework-populated) and `input.options` (format-specific).

### Merged Schema for UI

When the UI needs to render an export settings form for a format, it reads from the capabilities manifest (emitted at initialization via the `initialized` response). The manifest contains `schema` (JSON Schema — converted from Zod by the worker during startup) and `defaults` per format. The UI merges the universal export JSON Schema with the format-specific JSON Schema to produce the full RJSF form. The UI never touches Zod — it operates entirely on JSON Schema received from the worker. No additional RPC needed.

### UI Component

An `ExportSettings` component uses the same RJSF infrastructure as `parameters.tsx`:

```typescript
type ExportSettingsProps = {
  format: ExportFormat;
  schema: RJSFSchema;
  defaults: Record<string, unknown>;
  values: Record<string, unknown>;
  onValuesChange: (values: Record<string, unknown>) => void;
};
```

This reuses `rjsf-theme.tsx`, `FieldTemplate`, `ModifiedIndicator`, and delta-extraction patterns from the parameter editor.

## Fallback Export: Tessellation Consistency

### Problem

When a kernel lacks native export for a format (e.g., Manifold cannot export STL), the runtime falls back to converting from GLB. The intermediate GLB must have tessellation that matches what the export consumer expects — not the preview tessellation used for rendering.

### Design

The fallback path in the framework's export handler (the innermost function in the middleware chain):

1. Check if the active kernel's `exportFormats` includes the requested format
2. If not, request GLB from the active kernel using the **export tessellation** (from `options.tessellation` or `clientOptions.tessellation.export`)
3. Call `exportFromGlb` from `@taucad/converter` directly to convert the GLB to the target format

```typescript
// Pseudocode in KernelWorker export handler
import { exportFromGlb } from '@taucad/converter';

async function handleExport(format, options, kernel, nativeHandle) {
  const exportTessellation = options?.tessellation ?? this.clientOptions.tessellation?.export;

  if (kernel.exportFormats.includes(format)) {
    return kernel.definition.exportGeometry(
      { format, tessellation: exportTessellation, nativeHandle, options },
      runtime,
      kernel.context,
    );
  }

  // Fallback: produce export-quality GLB, then convert
  if (!kernel.exportFormats.includes('glb')) {
    throw new Error(
      `Kernel "${kernel.id}" cannot export "${format}" and does not support GLB fallback. ` +
        `Available formats: ${kernel.exportFormats.join(', ')}.`,
    );
  }

  const glbResult = await kernel.definition.exportGeometry(
    { format: 'glb', tessellation: exportTessellation, nativeHandle, options: {} },
    runtime,
    kernel.context,
  );

  if (!glbResult.success) return glbResult;

  const converted = await exportFromGlb(glbResult.data[0].bytes, format);
  return { success: true, data: [converted], issues: glbResult.issues };
}
```

Key design decisions:

- **Direct `exportFromGlb` import**, not a second kernel lifecycle. The framework imports the converter function as an internal dependency. No `this.findKernel('tau')`, no multi-kernel worker complexity.
- **Middleware wraps the outer operation**. The middleware chain sees `format: 'stl'` on the input and the final STL bytes on the output. The intermediate GLB production is an internal framework step that does NOT re-enter the middleware chain.
- **Export tessellation** is used for the intermediate GLB (high quality, e.g., `linearTolerance: 0.01`), not preview tessellation (lower quality, e.g., `linearTolerance: 0.1`).
- **Actionable error** when both native export and GLB fallback are unavailable (per library-api-policy §19).

## Per-CU Export in the Autonomous Topology

### Architecture Constraint

Each `RuntimeClient` owns a single compilation unit. The CU is set via `client.setFile()`. Export operates on the last-rendered geometry of that CU's native handle. There is no `compilationUnit` parameter on `client.export()` — the client IS the CU.

### Multi-CU Export is a UI Concern

The project machine manages `compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>`. Each `cadMachine` holds a `kernelClient: RuntimeClient`. Multi-CU export is orchestrated by the UI:

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

### Problem

Today, UI components statically import `supportedExportFormats` from `@taucad/converter/formats`. These static imports create a tight coupling to the converter package and cannot reflect which formats are actually available for the current kernel configuration.

### Design: Feed from Capabilities

After capability discovery, the capabilities manifest is the sole source of truth for available formats. UI components derive their format lists from the manifest:

```typescript
const capabilities = useSelector(cadActor, (s) => s.context.capabilities);
const availableFormats = capabilities?.exportFormats ?? [];

<FormatSelector
  formats={availableFormats.map(f => ({
    format: f.format,
    fidelity: f.fidelity,
    kernelId: f.kernelId,
  }))}
  selectedFormats={selectedFormats}
  onToggle={handleFormatToggle}
/>
```

Format display metadata (file extensions, MIME types) is already available in `@taucad/types` via `fileExtensionFromExportFormat`. No additional subpath export is needed — `@taucad/types` already provides the mapping from format strings to extensions. Any UI-specific enrichment (icons, labels) is a UI concern, not a runtime concern.

### Exception: Standalone Converter Route

The `/converter` route is a standalone product — a file conversion tool independent of any kernel. It is the only acceptable direct consumer of `@taucad/converter` and its static format lists. This route does not use `RuntimeClient` and continues importing from `@taucad/converter` directly.

## Export Preference Persistence

### Storage Location

Export preferences persist under `.tau/export/` in the project filesystem, alongside `.tau/parameters/`:

```
.tau/
├── parameters/
│   └── main.ts.json        # Parameter groups per CU
└── export/
    └── preferences.json    # Export format preferences
```

### Schema

```typescript
type ExportPreferences = {
  /** Last-used export options per format */
  formatOptions: Partial<Record<ExportFormat, Record<string, unknown>>>;
  /** Last-selected formats for multi-format export */
  selectedFormats: ExportFormat[];
  /** Whether to ZIP multiple format exports */
  zipMultiple: boolean;
};
```

### Lifecycle and Ownership

The **project machine** manages export preferences using the same actor pattern as parameter persistence:

1. On first export panel open: read `.tau/export/preferences.json` (create with defaults if absent)
2. On format selection change: write updated `selectedFormats`
3. On export options change: write updated `formatOptions[format]`
4. On export: preferences are already current

The project machine receives events from the chat-converter panel (`updateExportPreferences`, `selectExportFormats`) and persists via a `writeExportPreferencesActor`, mirroring the `writeParameterFileActor` pattern.

## Converter Consolidation

### Dependency Audit Summary

16 files import from `@taucad/converter`. After migration:

| Category                            | Files                                                                                                                                                          | Target                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Export calls → RuntimeClient**    | `converter.tsx`, `use-ar.ts`, `use-geometry-export.ts`                                                                                                         | `client.export()` via runtime                                                |
| **Format metadata → @taucad/types** | `file-extension-icon.tsx`, `format-selector.tsx`, `converter-utils.ts`, `formats-list.tsx`, `chat-converter.tsx`, `hero-viewer.tsx`, `converter-file-tree.tsx` | `fileExtensionFromExportFormat` from `@taucad/types` + capabilities manifest |
| **Internal to runtime**             | `tau.kernel.ts`, `gltf-edge-detection.middleware.ts`, `gltf-coordinate-transform.middleware.ts`, framework export handler                                      | Keep as internal (converter is a runtime dependency)                         |
| **Standalone exception**            | `routes/converter/route.tsx`                                                                                                                                   | Keep direct converter import                                                 |

### Target Dependency Graph

```
apps/ui
  └── @taucad/runtime           (all export via RuntimeClient)
  └── @taucad/types              (format constants, file extensions)

@taucad/react
  └── @taucad/runtime           (RuntimeClient for export)

@taucad/runtime (internal)
  └── @taucad/converter         (Tau kernel, middleware, fallback export handler)

Standalone exception:
  apps/ui/routes/converter/     (direct @taucad/converter usage)
```

### Migration Phases

**Phase 1**: Add `exportFormats` field to `KernelPlugin`, add `exportSchemas` named exports to kernel modules, implement worker-side Zod → JSON Schema conversion during discovery, extend `initialized` response with `CapabilitiesManifest`, emit `capabilities` event on `RuntimeClient`

**Phase 2**: Add `options` to `ExportGeometryInput` and protocol, implement worker-side runtime validation of export options against JSON Schema, rename `fileType` → `format` on `ExportGeometryInput`

**Phase 3**: Implement fallback export routing in the framework's export handler (kernel GLB → `exportFromGlb` for target format)

**Phase 4**: Remove `stl-binary` and `step-assembly` from `ExportFormat`, add corresponding schema-driven options (authored in Zod) to kernel module `exportSchemas`

**Phase 5**: Refactor chat-converter panel to use `RuntimeClient.export()`, add CU selector, render dynamic format list from capabilities manifest

**Phase 6**: Migrate `use-ar.ts` to `RuntimeClient.export('usdz')`, deprecate `useGeometryExport` in `@taucad/react`

**Phase 7**: Implement export preference persistence under `.tau/export/`

**Phase 8**: Remove `@taucad/converter` from `apps/ui` and `packages/react` `package.json`

## Recommendations

| #   | Action                                                                                                                     | Priority | Effort | Impact                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------- |
| R1  | Add required `exportFormats` field to `KernelPlugin`; add `exportSchemas` named export convention to kernel modules        | P0       | Medium | High — foundation for type safety and discovery |
| R2  | Author Zod export option schemas per kernel module (`exportSchemas` export); worker converts to JSON Schema during startup | P0       | Medium | High — enables schema-driven config             |
| R3  | Extend `initialized` response with `CapabilitiesManifest`                                                                  | P0       | Medium | High — autonomous discovery                     |
| R4  | Add `options?: Record<string, unknown>` to `ExportGeometryInput` and protocol                                              | P0       | Low    | High — enables all export configuration         |
| R5  | Rename `fileType` → `format` on `ExportGeometryInput`                                                                      | P0       | Low    | Medium — naming consistency with protocol       |
| R6  | Remove `stl-binary` and `step-assembly` from `ExportFormat`; add as schema-driven options                                  | P1       | Medium | High — cleaner format model                     |
| R7  | Implement fallback export in the framework export handler via `exportFromGlb`                                              | P0       | Medium | High — eliminates Path B                        |
| R8  | Refactor chat-converter panel: `RuntimeClient.export()`, CU selector, dynamic formats from capabilities                    | P0       | High   | High — primary UI consolidation                 |
| R9  | Migrate `use-ar.ts` to `RuntimeClient.export('usdz')` via fallback                                                         | P1       | Low    | Medium — AR through unified pipeline            |
| R10 | Make `createRuntimeClient` generic over plugin tuple for type-safe format constraints                                      | P1       | High   | High — compile-time format validation           |
| R11 | Build `ExportSettings` RJSF component using capabilities manifest schemas                                                  | P1       | Medium | High — user-facing config UI                    |
| R12 | Implement export preference persistence under `.tau/export/preferences.json`                                               | P2       | Medium | Medium — remembers user choices                 |
| R13 | Deprecate `useGeometryExport` in `@taucad/react`; replace with runtime-backed hook                                         | P2       | Low    | Medium — removes converter dep                  |
| R14 | Remove command palette export items; single "Open Exporter" command                                                        | P2       | Low    | Medium — reduces fragmentation                  |
| R15 | Remove `@taucad/converter` from `apps/ui` and `packages/react` dependencies                                                | P2       | Low    | Medium — enforces boundary                      |
| R16 | Implement Draco/Meshopt encoding in framework GLB export path via gltf-transform                                           | P2       | Medium | Medium — unlocks compression                    |
| R17 | Set `tessellation.export` in `defaultKernelOptions`                                                                        | P0       | Low    | High — fixes silent quality fallback            |

## References

- Unified Export Pipeline Architecture: `docs/research/unified-export-pipeline-architecture.md`
- Schema-Driven Export Configuration: `docs/research/schema-driven-export-configuration.md`
- Converter Runtime Consolidation: `docs/research/converter-runtime-consolidation.md`
- Library API Policy: `docs/policy/library-api-policy.md`
- Parameter Architecture v2: `docs/research/parameter-architecture-v2.md`
- Autonomous Kernel Topology Plan: `.cursor/plans/autonomous_kernel_topology_108929fd.plan.md`
- Runtime client: `packages/runtime/src/client/runtime-client.ts`
- Kernel definition types: `packages/runtime/src/types/runtime-kernel.types.ts`
- Plugin helpers: `packages/runtime/src/plugins/plugin-helpers.ts`
- Plugin types: `packages/runtime/src/plugins/plugin-types.ts`
- CAD machine: `apps/ui/app/machines/cad.machine.ts`
- Kernel factories: `packages/runtime/src/plugins/kernel-factories.ts`
- Export format constants: `libs/types/src/constants/file.constants.ts`

## Appendix

### A. Per-Kernel Native Export Format Matrix

With `stl-binary` and `step-assembly` removed as format types:

| Kernel          | stl               | step              | glb               | gltf              | 3mf               | Fidelity                   |
| --------------- | ----------------- | ----------------- | ----------------- | ----------------- | ----------------- | -------------------------- |
| Replicad        | Yes               | Yes               | Yes               | Yes               | —                 | brep (step), mesh (others) |
| OpenCascade     | Yes               | Yes               | Yes               | Yes               | —                 | brep (step), mesh (others) |
| Manifold        | —                 | —                 | Yes               | Yes               | —                 | mesh                       |
| OpenSCAD        | Yes               | —                 | Yes               | Yes               | Yes               | mesh                       |
| JSCAD           | —                 | —                 | Yes               | Yes               | —                 | mesh                       |
| Zoo (KCL)       | Yes               | Yes               | Yes               | Yes               | —                 | brep (step), mesh (others) |
| Tau (converter) | All via converter | All via converter | All via converter | All via converter | All via converter | mesh                       |

### B. Export Options Schema per Format

Authored in Zod in kernel modules (worker-only), converted to JSON Schema (interop) by the worker during startup.

| Format       | Option                            | Zod Type (authoring)                   | Default        |
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

### C. Protocol Extension Summary

```typescript
// RuntimeCommand — export
| {
    type: 'export';
    requestId: string;
    format: ExportFormat;
    options?: Record<string, unknown>;
  }

// RuntimeResponse — initialized (extended)
| {
    type: 'initialized';
    requestId: string;
    capabilities: CapabilitiesManifest;
  }

// ExportGeometryInput (updated)
type ExportGeometryInput<NativeHandle = unknown> = {
  format: ExportFormat;
  tessellation?: Tessellation;
  nativeHandle: NativeHandle;
  options?: Record<string, unknown>;
};
```

### D. Type Safety Flow

```
createKernelPlugin<ReplicadOptions>({ exportFormats: ['stl', 'step', 'glb', 'gltf'] as const })
  → replicad(): KernelPlugin<['stl', 'step', 'glb', 'gltf']>
    → createRuntimeClient({ kernels: [replicad(), manifold()] })
      → RuntimeClient<'stl' | 'step' | 'glb' | 'gltf'>
        → client.export('stl')     ✓ compiles
        → client.export('usdz')    ✗ error: not in union

// With Tau kernel (universal fallback):
createRuntimeClient({ kernels: [replicad(), tau()] })
  → RuntimeClient<'stl' | 'step' | 'glb' | 'gltf' | ... all converter formats>
    → client.export('usdz')        ✓ compiles (tau supports it)
```

### E. Client API Export Overloads (Updated)

```typescript
type RuntimeClient<F extends ExportFormat = ExportFormat> = {
  /** Export from inline code (self-rendering). */
  export<T extends Record<string, string>>(format: F, input: CodeInput<T>): Promise<ExportResult>;

  /** Export from connected filesystem (self-rendering). */
  export(format: F, input: FileInput): Promise<ExportResult>;

  /** Export from last render with format-specific options. */
  export(format: F, options?: Record<string, unknown>): Promise<ExportResult>;
};
```

The `format` parameter is constrained to `F` — the union of all formats declared by registered kernel plugins' `exportFormats`. Format-specific options (e.g., `{ binary: true }` for STL) are flat in the `options` parameter, alongside universal options like `tessellation`. The worker validates options against the merged JSON Schema (converted from Zod during worker startup) and separates universal concerns (tessellation) from format-specific options before dispatching to the kernel.

### F. `.tau/export/preferences.json` Example

```json
{
  "selectedFormats": ["step", "stl"],
  "zipMultiple": true,
  "formatOptions": {
    "stl": {
      "binary": true,
      "tessellation": {
        "linearTolerance": 0.005,
        "angularTolerance": 15
      }
    },
    "step": {
      "assemblyMode": "assembly"
    },
    "glb": {
      "compression": "draco",
      "draco": {
        "quantizationBits": {
          "position": 12
        }
      }
    }
  }
}
```

### G. Naming Alignment Summary

Consistent naming across all layers:

| Concept      | Plugin (main thread)   | Kernel Module (worker)                 | Manifest (runtime)                                        | Client API                | Protocol                  | Kernel Input                     |
| ------------ | ---------------------- | -------------------------------------- | --------------------------------------------------------- | ------------------------- | ------------------------- | -------------------------------- |
| Format       | `plugin.exportFormats` | —                                      | `manifest.exportFormats[].format`                         | `export(format)`          | `command.format`          | `input.format`                   |
| Schema       | —                      | `exportSchemas[fmt]` (Zod — authoring) | `manifest.exportFormats[].schema` (JSON Schema — interop) | —                         | —                         | —                                |
| Options      | —                      | —                                      | `manifest.exportFormats[].defaults`                       | `export(format, options)` | `command.options`         | `input.options`                  |
| Tessellation | —                      | —                                      | (in schema)                                               | in `options.tessellation` | in `options.tessellation` | `input.tessellation` (extracted) |
| Fidelity     | —                      | —                                      | `manifest.exportFormats[].fidelity`                       | —                         | —                         | —                                |

Zod schemas exist only in kernel modules, imported solely by the worker during the startup discovery phase. The main thread never imports Zod — it receives JSON Schema via the `initialized` response. All downstream consumers (manifest, UI, RJSF, persistence) operate exclusively on JSON Schema.
