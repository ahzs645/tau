---
title: 'Schema-Driven Export Configuration'
description: 'Design for JSON Schema-driven export options (tessellation, orientation, compression) with RJSF form generation, mirroring the kernel parameter pattern'
status: superseded
superseded_by: docs/research/export-pipeline-v2.md
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/unified-export-pipeline-architecture.md
  - docs/policy/library-api-policy.md
  - docs/research/parameter-architecture-v2.md
---

# Schema-Driven Export Configuration

Design for extending the runtime export pipeline with per-format, schema-driven configuration that produces RJSF forms in the UI — mirroring how kernel `getParameters` drives parameter forms from JSON Schema today.

## Executive Summary

The current export API accepts only `format` and optional `tessellation`. Users cannot control Draco compression, up-axis orientation, STL binary mode, STEP precision, or any format-specific option. The kernel parameter system already demonstrates a proven pattern: kernels return JSON Schema from `getParameters`, the UI renders forms via RJSF, and user overrides flow back through the protocol as `Record<string, unknown>`. This document designs an analogous system for export configuration — where each format declares a JSON Schema of its options, the UI renders export-settings forms, and user choices flow through the protocol to the worker thread where kernels and exporter providers consume them.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Existing Parameter Schema Pattern](#finding-1-existing-parameter-schema-pattern)
- [Finding 2: Current Export Configuration Surface](#finding-2-current-export-configuration-surface)
- [Finding 3: Format-Specific Options That Should Exist](#finding-3-format-specific-options-that-should-exist)
- [Finding 4: Two Extension Points for Export Config](#finding-4-two-extension-points-for-export-config)
- [Target Architecture](#target-architecture)
- [API Design](#api-design)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)

## Problem Statement

Export operations today accept `format` and an optional `Tessellation` (two numeric fields). Users have no control over:

- **Tessellation quality** beyond linear/angular tolerance (no `$fn`-style segment count, no curve abscissa)
- **Coordinate orientation** — all exports use hardcoded conventions (Y-up for glTF, Z-up for CAD); the viewer's `upDirection` setting does not propagate
- **Compression** — no Draco, Meshopt, or quantization options for glTF/GLB export despite the converter having gltf-transform available
- **STL binary vs ASCII** — the `stl-binary` format string is the only mechanism; there is no toggle within an "STL options" UI
- **STEP precision** — no schema/version control, writer precision, or assembly options
- **3MF metadata** — no author, title, or color options
- **USDZ AR** — no scene scale, environment, or interaction hints

The `defaultKernelOptions` in the app sets `tessellation.preview` but leaves `tessellation.export` undefined, meaning export tessellation silently falls back to per-kernel hardcoded defaults with no UI to adjust it.

## Methodology

Analysis of the existing `getParameters` → JSON Schema → RJSF pipeline, the runtime protocol types, middleware runtime context, `ExportGeometryInput`, and all format-specific export code in kernels and the converter package.

## Findings

### Finding 1: Existing Parameter Schema Pattern

The kernel parameter system is a proven schema-driven pipeline:

```
Kernel.getParameters() → { jsonSchema, defaultParameters }
    ↓ (via parametersResolved event)
UI: RJSF Form (parameters.tsx + rjsf-theme.tsx)
    ↓ (user edits)
cad.machine → setParameters → protocol → worker → kernel.createGeometry(input)
```

Key components:

| Component                               | Role                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GetParametersResult.jsonSchema`        | `unknown` at the boundary, narrowed to `JSONSchema7` in UI                             |
| `GetParametersResult.defaultParameters` | `Record<string, unknown>` — merged with user overrides via deepmerge                   |
| `parameters.tsx`                        | RJSF `Form` with custom `rjsf-theme.tsx` templates, delta extraction, reset-to-default |
| `RuntimeCommand.render.params`          | User overrides transported over the protocol as `Record<string, unknown>`              |
| `KernelWorker.render`                   | Merges `defaultParameters` + caller `parameters` via deepmerge before `createGeometry` |

This pattern demonstrates that JSON Schema → RJSF forms → protocol transport → worker-side consumption works at scale. Export configuration can follow the same architecture.

### Finding 2: Current Export Configuration Surface

Today's export-related configuration across all layers:

| Layer                               | Available Config                                    | Missing                                      |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `RuntimeClientOptions.tessellation` | `{ preview?: Tessellation, export?: Tessellation }` | Only 2 numeric fields; no per-format options |
| `RuntimeClient.export()`            | `format` + optional `{ tessellation }`              | No options bag for format-specific config    |
| `RuntimeCommand.export`             | `format`, `tessellation?`                           | No `exportOptions` field                     |
| `ExportGeometryInput`               | `fileType`, `tessellation?`, `nativeHandle`         | No options bag                               |
| `Converter.exportFromGlb`           | `(glbData, format)`                                 | No options parameter at all                  |
| `GltfExporter`                      | `binary` (hardcoded per config entry)               | No Draco/Meshopt/quantization                |
| `AssimpExporter`                    | `format`, `targetExtension`                         | No writer property bags                      |
| Chat-converter UI                   | Format multi-select, ZIP toggle                     | No quality/orientation/compression controls  |

### Finding 3: Format-Specific Options That Should Exist

Analysis of target format specifications and common CAD export tools reveals these configuration dimensions:

| Format          | Option                            | Type                                 | Default        | Notes                                |
| --------------- | --------------------------------- | ------------------------------------ | -------------- | ------------------------------------ |
| **All formats** | `tessellation.linearTolerance`    | number                               | Kernel default | Mesh deviation from true surface     |
| **All formats** | `tessellation.angularTolerance`   | number                               | 30             | Facet angular deviation (degrees)    |
| **glTF/GLB**    | `compression`                     | `'none'` \| `'draco'` \| `'meshopt'` | `'none'`       | gltf-transform has encoders for both |
| **glTF/GLB**    | `draco.quantizationBits.position` | integer (8-16)                       | 14             | Draco position quantization          |
| **glTF/GLB**    | `draco.quantizationBits.normal`   | integer (8-16)                       | 10             | Draco normal quantization            |
| **glTF/GLB**    | `meshopt.level`                   | `'medium'` \| `'high'`               | `'medium'`     | Meshopt filter level                 |
| **glTF/GLB**    | `includeEdges`                    | boolean                              | false          | Include edge-detection data          |
| **STL**         | `binary`                          | boolean                              | true           | Binary vs ASCII output               |
| **STL**         | `coordinateSystem`                | `'y-up'` \| `'z-up'`                 | `'z-up'`       | Conventional for 3D printing         |
| **STEP**        | `schema`                          | `'ap203'` \| `'ap214'` \| `'ap242'`  | `'ap214'`      | STEP application protocol            |
| **STEP**        | `assemblyMode`                    | `'single'` \| `'assembly'`           | `'single'`     | Flat vs structured output            |
| **3MF**         | `units`                           | `'millimeter'` \| `'inch'`           | `'millimeter'` | 3MF model units                      |
| **USDZ**        | `sceneScale`                      | number                               | 1.0            | AR scene scale multiplier            |

### Finding 4: Two Extension Points for Export Config

There are two viable paths to inject export configuration, each suited for different use cases:

**Path 1: Per-call options via protocol extension**

User-facing, changes per export invocation. Requires threading through the full stack:

```
RuntimeClient.export(format, { exportOptions }) →
  RuntimeCommand.export.exportOptions →
    KernelWorker.exportGeometry(format, tessellation, exportOptions) →
      ExportGeometryInput.exportOptions →
        kernel.exportGeometry(input, runtime, context)
```

**Path 2: Middleware options via optionsSchema**

Middleware-scoped, fixed at registration. Already works today — middleware reads `runtime.options` in `wrapExportGeometry`. Suited for framework-level export behaviors (coordinate transforms, compression) that are configured once, not per-click.

Both paths are complementary, not competing. Per-call options are for user-facing controls (the export settings form). Middleware options are for framework-level policies (always apply Draco, always normalize coordinates).

## Target Architecture

### Schema Declaration

Each export format declares its options schema. Schemas are owned by:

- **Kernels** — for format options the kernel natively understands (STEP schema, tessellation)
- **Exporter providers** — for converter-specific options (Draco compression, Meshopt)
- **The runtime framework** — for universal options (coordinate system, units)

### Export Options Schema Resolution

```
┌─────────────────────────────────────────────────────┐
│ getExportOptionsSchema(format)                      │
│                                                     │
│ 1. Start with universal schema (tessellation, etc.) │
│ 2. If kernel natively supports format:              │
│    → Merge kernel's format-specific schema          │
│ 3. Else if exporter provider handles format:        │
│    → Merge provider's format-specific schema        │
│ 4. Return merged JSON Schema + defaults             │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ UI: RJSF Form        │
         │ (export-settings.tsx) │
         └───────────┬───────────┘
                     │ user edits
                     ▼
         ┌───────────────────────┐
         │ RuntimeClient.export  │
         │ (format, {            │
         │   exportOptions: {...}│
         │ })                    │
         └───────────┬───────────┘
                     │ protocol
                     ▼
         ┌───────────────────────┐
         │ ExportGeometryInput   │
         │ { fileType,           │
         │   tessellation?,      │
         │   nativeHandle,       │
         │   exportOptions? }    │
         └───────────────────────┘
```

### Protocol Extension

The `RuntimeCommand` export variant gains an `exportOptions` field:

```typescript
type RuntimeCommand =
  // ...
  {
    type: 'export';
    requestId: string;
    format: ExportFormat;
    tessellation?: Tessellation;
    exportOptions?: Record<string, unknown>;
  };
```

This is the same `Record<string, unknown>` pattern used by `render.params` — schema-validated on the worker side, untyped on the wire for extensibility.

### New Protocol: Export Schema Query

A new request/response pair enables the UI to query available export options for a format:

```typescript
// Command
| {
    type: 'getExportSchema';
    requestId: string;
    format: ExportFormat;
  }

// Response
| {
    type: 'exportSchemaResolved';
    requestId: string;
    result: ExportSchemaResult;
  }
```

Where `ExportSchemaResult` mirrors `GetParametersResult`:

```typescript
type ExportSchemaResult = KernelResult<{
  jsonSchema: unknown;
  defaultOptions: Record<string, unknown>;
}>;
```

## API Design

### 1. Kernel Export Schema Declaration

Kernels declare per-format export schemas via a new optional method:

```typescript
type KernelDefinition<Context, NativeHandle, Options> = {
  // ... existing fields ...

  /** Return JSON Schema and defaults for format-specific export options. */
  getExportSchema?(
    input: { format: ExportFormat },
    runtime: KernelRuntime,
    context: Context,
  ): Promise<ExportSchemaResult>;
};
```

Example in replicad kernel:

```typescript
async getExportSchema({ format }, _runtime, _context) {
  switch (format) {
    case 'step':
      return {
        success: true,
        data: {
          jsonSchema: {
            type: 'object',
            properties: {
              assemblyMode: {
                type: 'string',
                enum: ['single', 'assembly'],
                default: 'single',
                title: 'Assembly Mode',
                description: 'Export as flat geometry or structured assembly',
              },
            },
          },
          defaultOptions: { assemblyMode: 'single' },
        },
      };
    case 'stl':
      return {
        success: true,
        data: {
          jsonSchema: {
            type: 'object',
            properties: {
              binary: {
                type: 'boolean',
                default: true,
                title: 'Binary STL',
                description: 'Binary format is smaller; ASCII is human-readable',
              },
            },
          },
          defaultOptions: { binary: true },
        },
      };
    default:
      return { success: true, data: { jsonSchema: { type: 'object' }, defaultOptions: {} } };
  }
}
```

### 2. Exporter Provider Schema Declaration

Exporter providers declare schemas for formats they handle:

```typescript
type ExporterProvider = {
  id: string;
  capabilities: readonly ExporterCapability[];
  /** Return JSON Schema for provider-specific export options. */
  getExportSchema?(format: ExportFormat): ExportSchemaResult;
  exportFromGlb(
    glbData: Uint8Array<ArrayBuffer>,
    format: ExportFormat,
    options?: Record<string, unknown>,
  ): Promise<ExportFile[]>;
};
```

Example for the built-in converter provider:

```typescript
const tauConverter = defineExporterProvider({
  id: 'tau-converter',
  capabilities: [
    /* ... */
  ],
  getExportSchema(format) {
    if (format === 'glb' || format === 'gltf') {
      return {
        success: true,
        data: {
          jsonSchema: {
            type: 'object',
            properties: {
              compression: {
                type: 'string',
                enum: ['none', 'draco', 'meshopt'],
                default: 'none',
                title: 'Compression',
              },
              draco: {
                type: 'object',
                title: 'Draco Options',
                properties: {
                  quantizationBits: {
                    type: 'object',
                    properties: {
                      position: { type: 'integer', minimum: 8, maximum: 16, default: 14 },
                      normal: { type: 'integer', minimum: 8, maximum: 16, default: 10 },
                    },
                  },
                },
              },
            },
          },
          defaultOptions: { compression: 'none' },
        },
      };
    }
    return { success: true, data: { jsonSchema: { type: 'object' }, defaultOptions: {} } };
  },
});
```

### 3. Universal Export Schema

The runtime framework provides a base schema merged into all export format schemas:

```typescript
const universalExportSchema = {
  type: 'object',
  properties: {
    tessellation: {
      type: 'object',
      title: 'Tessellation Quality',
      properties: {
        linearTolerance: {
          type: 'number',
          minimum: 0.001,
          maximum: 10,
          default: 0.01,
          title: 'Linear Tolerance',
          description: 'Maximum mesh-to-surface deviation (model units)',
        },
        angularTolerance: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          default: 30,
          title: 'Angular Tolerance',
          description: 'Maximum facet angular deviation (degrees)',
        },
      },
    },
    coordinateSystem: {
      type: 'string',
      enum: ['y-up', 'z-up'],
      title: 'Up Axis',
      description: 'Override the default coordinate convention for this format',
    },
  },
};
```

### 4. Schema Merge Strategy

When the UI requests an export schema for a format, the runtime merges three layers:

```
Universal schema (tessellation, coordinateSystem)
    ⊕ Kernel schema (format-specific, if kernel supports format)
    ⊕ Provider schema (format-specific, if using fallback)
    = Merged JSON Schema + merged defaults
```

Merge uses `allOf` composition or property-level deep merge, with kernel-specific properties taking precedence over provider properties. The merged result is a single JSON Schema document with a single `defaultOptions` record.

### 5. ExportGeometryInput Extension

```typescript
type ExportGeometryInput<NativeHandle = unknown> = {
  fileType: ExportFormat;
  tessellation?: Tessellation;
  nativeHandle: NativeHandle;
  /** Schema-validated export options from the UI. */
  exportOptions?: Record<string, unknown>;
};
```

Kernels and middleware read `input.exportOptions` to apply format-specific behavior. The framework validates options against the merged schema before dispatching to the kernel.

### 6. RuntimeClient.export Extension

```typescript
type ExportCallOptions = {
  tessellation?: Tessellation;
  /** Per-format export options (schema-driven). */
  exportOptions?: Record<string, unknown>;
};

// Existing overload gains exportOptions:
export(format: ExportFormat, callOptions?: ExportCallOptions): Promise<ExportResult>;

// New method to query available options:
getExportSchema(format: ExportFormat): Promise<ExportSchemaResult>;
```

### 7. UI: Export Settings Component

A new `ExportSettings` component mirrors `Parameters`:

```typescript
type ExportSettingsProps = {
  format: ExportFormat;
  jsonSchema: RJSFSchema;
  defaultOptions: Record<string, unknown>;
  options: Record<string, unknown>;
  onOptionsChange: (options: Record<string, unknown>) => void;
};
```

This component uses the same RJSF infrastructure (`rjsf-theme.tsx`, `FieldTemplate`, `ModifiedIndicator`) as the parameter editor, ensuring visual consistency. It renders inside the chat-converter panel, below format selection.

### 8. Lifecycle: Format Selection → Schema Fetch → Form → Export

```
1. User selects format in chat-converter panel
2. UI calls client.getExportSchema(format)
3. Runtime queries kernel.getExportSchema + provider.getExportSchema + universal
4. Merged { jsonSchema, defaultOptions } returned to UI
5. ExportSettings form renders with RJSF
6. User adjusts options (or accepts defaults)
7. User clicks "Export"
8. UI calls client.export(format, { exportOptions: mergedUserOptions })
9. Protocol carries exportOptions to worker
10. KernelWorker.exportGeometry receives full input including exportOptions
11. Kernel/middleware/provider reads exportOptions and applies format-specific behavior
```

## Recommendations

| #   | Action                                                                                             | Priority | Effort | Impact                                          |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------- |
| R1  | Add `exportOptions?: Record<string, unknown>` to `ExportGeometryInput` and `RuntimeCommand.export` | P0       | Low    | High — enables entire feature                   |
| R2  | Thread `exportOptions` through `RuntimeClient.export`, `RuntimeWorkerClient`, `KernelWorker`       | P0       | Medium | High — end-to-end plumbing                      |
| R3  | Add `getExportSchema?` to `KernelDefinition`                                                       | P0       | Low    | High — kernels can declare format options       |
| R4  | Add `getExportSchema?` to `ExporterProvider` interface                                             | P1       | Low    | Medium — providers declare options              |
| R5  | Define universal export schema (tessellation, coordinateSystem)                                    | P1       | Low    | Medium — baseline options for all formats       |
| R6  | Implement schema merge logic (universal ⊕ kernel ⊕ provider)                                       | P1       | Medium | High — produces the merged form schema          |
| R7  | Add `getExportSchema` / `exportSchemaResolved` protocol command/response                           | P1       | Medium | High — enables UI to fetch schemas              |
| R8  | Build `ExportSettings` RJSF component using existing `rjsf-theme.tsx`                              | P1       | Medium | High — user-facing configuration UI             |
| R9  | Implement Draco encoding in `GltfExporter` via gltf-transform                                      | P2       | Medium | Medium — unlocks glTF compression               |
| R10 | Implement Meshopt encoding in `GltfExporter` via gltf-transform                                    | P2       | Medium | Medium — alternative compression                |
| R11 | Wire `coordinateSystem` option to `gltf.transforms.ts` in export path                              | P2       | Low    | Medium — user-controlled orientation            |
| R12 | Implement STEP schema/precision options in replicad kernel                                         | P2       | Medium | Medium — STEP export fidelity control           |
| R13 | Set `tessellation.export` in `defaultKernelOptions`                                                | P0       | Low    | High — fixes silent fallback to kernel defaults |
| R14 | Persist export options per-format in cookies or `.tau/` config                                     | P2       | Low    | Medium — remembers user preferences             |

## Trade-offs

### Per-Call Options vs Middleware Options

| Dimension           | Per-Call (protocol extension)                  | Middleware (optionsSchema)                       |
| ------------------- | ---------------------------------------------- | ------------------------------------------------ |
| **Lifecycle**       | Changes every export invocation                | Fixed at middleware registration                 |
| **User control**    | Schema-driven UI form                          | Developer/integrator config                      |
| **Use cases**       | Tessellation quality, compression, binary mode | Coordinate transforms, cache policies, telemetry |
| **Protocol change** | Yes — new field on `RuntimeCommand.export`     | No — already works                               |
| **Schema source**   | Kernel + provider + universal                  | Middleware's own `optionsSchema`                 |

**Recommendation**: Implement both. Per-call options for user-facing controls, middleware options for framework policies. The two complement each other.

### Schema per Format vs Global Export Schema

**Option A: Single global export schema with conditional fields**

- Pro: One schema fetch per export session; simpler protocol
- Con: Large schema with many irrelevant fields; conditional visibility complexity

**Option B: Per-format schema fetched on format selection**

- Pro: Tight, relevant options per format; no conditional field logic
- Con: Schema fetch on every format switch; slight latency

**Option C: Batch all format schemas upfront**

- Pro: No per-selection latency; enables format comparison
- Con: Fetches schemas for formats the user may never select; larger payload

**Recommendation**: Option B — per-format schema fetch on selection. Schemas are small (sub-kilobyte JSON), the fetch is a single worker round-trip, and it keeps the form tightly scoped. Cache schemas client-side for the session to avoid redundant fetches.

### Tessellation in exportOptions vs Dedicated Field

The current `tessellation` field on `ExportGeometryInput` is a dedicated typed field. With schema-driven options, tessellation could live inside `exportOptions` instead.

**Keep both**: The dedicated `tessellation` field provides a typed, non-optional interface for kernels that always need it. The universal export schema exposes tessellation to the UI. The framework maps schema-driven tessellation values into the `tessellation` field before dispatching to the kernel, so kernels don't need to parse `exportOptions` for basic tessellation.

## Code Examples

### Current: No export options

```typescript
// User clicks "Export STL" — no quality/orientation/compression choices
await client.export('stl');
// → kernel uses hardcoded defaults
```

### Target: Schema-driven export

```typescript
// 1. UI fetches format-specific schema
const schema = await client.getExportSchema('glb');
// → { jsonSchema: { properties: { compression, draco, tessellation, ... } }, defaults }

// 2. RJSF renders form; user selects Draco compression
// 3. Export with user-chosen options
await client.export('glb', {
  exportOptions: {
    compression: 'draco',
    draco: { quantizationBits: { position: 12 } },
    tessellation: { linearTolerance: 0.005 },
  },
});
// → kernel/provider receives full options bag
```

## References

- Unified Export Pipeline Architecture: `docs/research/unified-export-pipeline-architecture.md`
- Library API Policy: `docs/policy/library-api-policy.md`
- Parameter Architecture: `docs/research/parameter-architecture-v2.md`
- RJSF theme: `apps/ui/app/components/geometry/parameters/rjsf-theme.tsx`
- Runtime kernel types: `packages/runtime/src/types/runtime-kernel.types.ts`
- Runtime protocol: `packages/runtime/src/types/runtime-protocol.types.ts`
- gltf-transform Draco docs: https://gltf-transform.dev/functions/draco
- gltf-transform Meshopt docs: https://gltf-transform.dev/functions/meshopt
