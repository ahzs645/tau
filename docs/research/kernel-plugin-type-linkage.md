---
title: 'Kernel–Plugin Type Linkage'
description: 'Analysis of the type-safety gap between defineKernel modules and createKernelPlugin registrations, with recommendations for schema-driven inference and concern separation.'
status: draft
created: '2026-04-15'
updated: '2026-04-15'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/research/export-option-schema-architecture.md
  - docs/research/schema-driven-export-configuration.md
  - docs/research/lazy-capabilities-manifest.md
  - docs/research/generic-inference-pipeline.md
---

# Kernel–Plugin Type Linkage

Investigation into the structural disconnect between kernel runtime modules (`defineKernel`) and their plugin registration counterparts (`createKernelPlugin`), with focus on type-safety gaps, schema duplication, concern bleed, and the path to compile-time verified linkage.

## Executive Summary

The current architecture separates each kernel into two files — a `*.kernel.ts` runtime module and a `*.plugin.ts` registration manifest. Both files independently declare the same Zod schemas (export options, render options), creating duplication with no compile-time linkage. The eigenquestion is: **"Can the plugin avoid carrying schemas entirely and let the kernel be the sole schema owner?"** The answer is no — the capabilities manifest must be built during worker initialization _before_ any kernel module is lazily loaded, so pre-computed JSON Schema must travel with the plugin registration. But the Zod source schemas that produce that JSON Schema can and should be declared exactly once in a lightweight `*.schemas.ts` file that both the plugin and kernel import. This eliminates all duplication, makes schema drift structurally impossible, and breaks the current circular import between plugin and kernel.

## The Eigenquestion

> **Why do both the plugin file and the kernel file need schemas, and can we avoid it?**

### The lifecycle timing constraint

The answer requires understanding a critical timing invariant in the worker lifecycle:

```
Main thread                          Worker thread
───────────                          ─────────────
createRuntimeClient()
  ├─ kernels.map(k => ({
  │    id, moduleUrl, options,
  │    exportSchemas: JSON Schema    ◄── Plugin's pre-computed JSON Schema
  │  }))
  └─ workerClient.initialize() ────► KernelWorker.initialize()
                                       ├─ onInitialize()
                                       │    └─ Store JSON Schema from plugin ──► kernelExportFormatsMap
                                       │                                        kernelExportOptionSchemasMap
                                       │                                        kernelRenderOptionSchemasMap
                                       ├─ buildCapabilitiesManifest() ◄── Uses plugin JSON Schema
                                       │    └─ CapabilitiesManifest sent to main thread
                                       │
                                       │  ... time passes, user opens a file ...
                                       │
                                       ├─ selectKernel() ◄── First render triggers lazy load
                                       │    └─ loadKernelModule()
                                       │         └─ import(moduleUrl) ◄── Kernel module loaded HERE
                                       │              └─ Store Zod schemas ──► kernelExportZodSchemasMap
                                       │                                       kernelRenderZodSchemaMap
                                       └─ exportGeometry()
                                            └─ Zod.safeParse() ◄── Uses kernel's Zod for validation
```

The capabilities manifest is built at step 3, using the plugin's pre-computed JSON Schema. Kernel modules are lazily loaded at step 4, potentially minutes later. The manifest cannot wait for kernel loading — the UI needs export format information immediately to render the export dialog.

### What the plugin actually needs

The plugin's JSON Schema is a **lossy projection** of the Zod source schema. `createKernelPlugin` calls `toJSONSchema(zodSchema)` and `zodSchema.parse({})` to produce `{ schema, defaults }` — a serializable representation. This conversion happens on the main thread during `createKernelPlugin()` execution.

The kernel's Zod schemas are used later in the worker for runtime validation via `safeParse()`.

Both consume the same Zod source objects. Currently, the plugin file owns those objects and the kernel file imports them from the plugin. But there is nothing that forces both files to use the same schemas, and no compile-time error if they diverge.

### The answer

**The Zod schemas should be declared exactly once in a `*.schemas.ts` file.** Both the plugin (which converts to JSON Schema) and the kernel (which uses Zod for runtime validation) import from it. The third file adds no new concern — it merely extracts the schema declarations that currently leak into the wrong files.

This is not the R4-as-nice-to-have from the previous version. It is the only correct answer to the eigenquestion: you cannot eliminate the dual consumption (JSON Schema for manifest, Zod for validation), but you can eliminate the dual declaration.

## Problem Statement

Each kernel in `@taucad/runtime` is split across two files:

| File          | Role                                                         | Runs where           |
| ------------- | ------------------------------------------------------------ | -------------------- |
| `*.kernel.ts` | `defineKernel()` — runtime lifecycle (init, render, export)  | Worker thread (lazy) |
| `*.plugin.ts` | `createKernelPlugin()` — static metadata + schema conversion | Main thread (eager)  |

The plugin file is loaded eagerly on the main thread (no WASM, no heavy deps). The kernel file is dynamically imported in the worker thread only when the kernel is selected. This split is architecturally sound — the problem is how the two sides share schema definitions.

### Current data flow (schemas declared in plugin, imported by kernel)

```
replicad.plugin.ts
  ├─ DECLARES occtRenderOptionSchema (Zod)
  ├─ DECLARES stlExportSchema, stepExportSchema, etc. (Zod)
  ├─ CONVERTS to JSON Schema via createKernelPlugin()
  ├─ IMPORTS type ReplicadOptions FROM replicad.kernel.ts
  └─ EXPORTS replicad() factory → KernelPlugin

replicad.kernel.ts
  ├─ IMPORTS stlExportSchema, occtRenderOptionSchema FROM replicad.plugin.ts
  ├─ DECLARES replicadOptionsSchema (Zod)
  ├─ EXPORTS type ReplicadOptions
  └─ EXPORTS defineKernel({ ...schemas, ...lifecycle })
```

This creates a circular dependency (plugin → kernel type, kernel → plugin value) and puts schema ownership in the wrong file — the plugin is a registration wrapper, not a schema authority.

### Concrete type-safety gaps

1. **No compile-time check** that the plugin's `exportSchemas` keys (`stl`, `step`, `glb`, `gltf`) match the kernel's `exportGeometry` switch cases
2. **No compile-time check** that the plugin's `renderSchema` is the same Zod object as the kernel's
3. **No compile-time check** that `createKernelPlugin<ReplicadOptions>` matches the kernel's `optionsSchema` output type
4. **Schema duplication**: `occtExportTessellationSchema` independently defined in both `replicad.plugin.ts` and `opencascade.plugin.ts`
5. **Wrong ownership**: `occtRenderOptionSchema` lives in `replicad.plugin.ts` but is imported by `opencascade.plugin.ts` and `opencascade.kernel.ts`

## Methodology

1. Full data-flow trace from `createKernelPlugin()` on the main thread through `postMessage` serialization into the worker, through `onInitialize` → `buildCapabilitiesManifest()`, and through lazy `loadKernelModule()` → `kernelExportZodSchemasMap`
2. Source analysis of all 7 kernel plugin files and their corresponding kernel modules
3. Lifecycle timing analysis: when is each schema representation consumed, and what depends on it being available?
4. Cross-referencing the `define-plugin.test-d.ts` type test suite against actual production types
5. Comparison with library-api-policy design principles (§2 Define Functions, §8 Plugin Factories, §12 TypeScript-First)

## Findings

### Finding 1: The capabilities manifest requires plugin-side JSON Schema (non-negotiable)

`buildCapabilitiesManifest()` runs during `KernelWorker.initialize()` (line 534 of `kernel-worker.ts`), immediately after `onInitialize()`. At this point, no kernel module has been loaded — kernel modules are lazily imported during `selectKernel()`, triggered by the first render. The manifest must be available immediately so the UI can display export format options.

This means the plugin registration MUST carry pre-computed JSON Schema + defaults. The conversion from Zod → JSON Schema cannot be deferred to kernel loading time.

### Finding 2: `renderSchema` is NOT serialized from client to worker

The `runtime-client.ts` maps `KernelPlugin` objects into `KernelModuleEntry` objects for the worker (lines 490–498), but only includes `exportSchemas` — not `renderSchema`. The worker gets render option schemas solely from the kernel definition's Zod schema (lines 336–337 of `kernel-runtime-worker.ts`), stored in `kernelRenderZodSchemaMap`.

Meanwhile, `KernelPlugin.renderSchema` (the JSON Schema form) exists on the plugin object but is never read by the runtime client. It is effectively dead data on the main thread side — the capabilities manifest's `renderOptions` array is populated from `kernelRenderOptionSchemasMap`, which is populated from `KernelModuleEntry.renderSchema`, which is never sent.

**Impact**: The plugin's Zod → JSON Schema conversion for `renderSchema` is wasted work. The render option schema should either be sent like `exportSchemas` (for manifest consistency) or removed from the plugin entirely and derived solely from the kernel definition at load time. This is a latent bug — the capabilities manifest's `renderOptions` will be empty despite kernels declaring render schemas.

### Finding 3: Five maps store overlapping schema data in the worker

The `KernelWorker` base class maintains five parallel schema maps:

| Map                            | Source                               | Populated when            | Used for                                            |
| ------------------------------ | ------------------------------------ | ------------------------- | --------------------------------------------------- |
| `kernelExportFormatsMap`       | Plugin's `exportSchemas` keys        | `onInitialize` (eager)    | Format availability checks                          |
| `kernelExportOptionSchemasMap` | Plugin's `exportSchemas` JSON Schema | `onInitialize` (eager)    | Capabilities manifest                               |
| `kernelRenderOptionSchemasMap` | Plugin's `renderSchema` JSON Schema  | `onInitialize` (eager)    | Capabilities manifest (currently broken — not sent) |
| `kernelExportZodSchemasMap`    | Kernel's `exportSchemas` Zod         | `loadKernelModule` (lazy) | Runtime `safeParse` validation                      |
| `kernelRenderZodSchemaMap`     | Kernel's `renderSchema` Zod          | `loadKernelModule` (lazy) | Runtime `safeParse` validation                      |

The first three are populated eagerly from plugin data. The last two are populated lazily from kernel data. There is no assertion that they agree.

### Finding 4: `defineKernel` has excellent internal type inference that doesn't escape

The `defineKernel` function infers 6 type parameters automatically (Context, NativeHandle, SerializedHandle, Options, ExportSchemas, RenderSchema). This creates a fully type-safe environment _within_ the kernel file. But none of these inferred types flow to the plugin file — they are consumed only inside `defineKernel`'s generic closure.

### Finding 5: Helper code duplicated across 4 kernel files

| Function/Type                 | Files                                  |
| ----------------------------- | -------------------------------------- |
| `KERNEL_MODULES_KEY` constant | replicad, opencascade, jscad, manifold |
| `getModuleRegistry()`         | replicad, opencascade, jscad, manifold |
| `isRecordObject()`            | replicad, opencascade                  |
| `extractDefaultParameters()`  | replicad, opencascade                  |
| `resolveToRelative()`         | replicad, opencascade                  |
| `enrichIssueLocation()`       | replicad, opencascade                  |
| `RuntimeModuleExports` type   | replicad, opencascade                  |

### Finding 6: Test-d field naming diverges from production types

The `define-plugin.test-d.ts` file uses `exportOptionSchemas` and `exportFormats` in `defineKernel` and `createKernelPlugin` calls. The production types use `exportSchemas` with no `exportFormats` field. The tests compile against a different API surface than what ships.

## Recommendations

### R1: Extract `*.schemas.ts` per kernel — single schema declaration (P0, Medium effort, Critical impact)

This is the direct answer to the eigenquestion. Create one `*.schemas.ts` file per kernel containing all Zod schema declarations. Both the plugin and kernel import from it. No schema is declared in either the plugin or kernel file.

**Before** (replicad — 2 files, circular deps, schemas in wrong place):

```
replicad.plugin.ts ──defines schemas──► DECLARES occtRenderOptionSchema, stlExportSchema, ...
                   ──import type───────► replicad.kernel.ts
replicad.kernel.ts ──import value──────► replicad.plugin.ts (imports schemas back)
                   ──defines schema───► DECLARES replicadOptionsSchema
```

**After** (replicad — 3 files, DAG, schemas in right place):

```
replicad.schemas.ts ──── DECLARES all schemas (single source of truth)
     ↑                    ↑
     │                    │
replicad.plugin.ts    replicad.kernel.ts
  (detection +          (runtime lifecycle)
   registration)
```

The `*.schemas.ts` file is lightweight — Zod imports only, no WASM, no heavy deps. Safe for main-thread import. Typical size: 15–30 lines.

```typescript
// replicad.schemas.ts
import { z } from 'zod';
import {
  occtRenderOptionSchema,
  occtStlExportSchema,
  occtStepExportSchema,
  occtGlbExportSchema,
  occtGltfExportSchema,
} from '#kernels/occt-shared-schemas.js';

export const replicadOptionsSchema = z.object({
  wasm: z
    .union([z.enum(['single']), z.object({ wasmUrl: z.string(), wasmBindingsUrl: z.string() })])
    .optional()
    .default('single'),
  ocTracing: z.enum(['off', 'summary', 'per-call']).optional().default('summary'),
  withBrepEdges: z.boolean().optional().default(false),
  withSourceMapping: z.boolean().optional().default(false),
});

export type ReplicadOptions = z.input<typeof replicadOptionsSchema>;

export const replicadRenderOptionSchema = occtRenderOptionSchema;

export const replicadExportSchemas = {
  stl: occtStlExportSchema,
  step: occtStepExportSchema,
  glb: occtGlbExportSchema,
  gltf: occtGltfExportSchema,
};
```

Plugin consumes — detection + registration only, no schema declarations:

```typescript
// replicad.plugin.ts
import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import {
  replicadRenderOptionSchema,
  replicadExportSchemas,
  type ReplicadOptions,
} from '#kernels/replicad/replicad.schemas.js';

export const replicadDetectPattern = /import.*from\s+["']replicad["']/s;

export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
  renderSchema: replicadRenderOptionSchema,
  exportSchemas: replicadExportSchemas,
});
```

Kernel consumes — runtime lifecycle only, no schema declarations:

```typescript
// replicad.kernel.ts
import {
  replicadOptionsSchema,
  replicadRenderOptionSchema,
  replicadExportSchemas,
} from '#kernels/replicad/replicad.schemas.js';

export default defineKernel({
  name: 'ReplicadKernel',
  version: '1.0.0',
  optionsSchema: replicadOptionsSchema,
  renderSchema: replicadRenderOptionSchema,
  exportSchemas: replicadExportSchemas,
  async initialize(options, runtime) {
    /* ... */
  },
  // ...
});
```

**Type-safety guarantee**: Both files spread the exact same object references. Schema drift is structurally impossible — there is one declaration site.

**Circular dependency elimination**: `schemas.ts` depends on nothing kernel- or plugin-specific. Both plugin and kernel depend on schemas. The dependency graph is a clean DAG.

### R2: Extract shared OCCT schemas to a canonical module (P0, Low effort, High impact)

Create `packages/runtime/src/kernels/occt-shared-schemas.ts` housing schemas shared by replicad and opencascade:

```typescript
import { z } from 'zod';
import { coordinateSystemSchema } from '#types/export-option-schemas.js';

export const occtRenderOptionSchema = z.object({
  tessellation: z
    .object({
      linearTolerance: z.number().positive().default(0.1),
      angularTolerance: z.number().positive().default(30),
    })
    .default({ linearTolerance: 0.1, angularTolerance: 30 }),
});

export const occtExportTessellationSchema = z.object({
  tessellation: z
    .object({
      linearTolerance: z.number().positive().default(0.01),
      angularTolerance: z.number().positive().default(30),
    })
    .default({ linearTolerance: 0.01, angularTolerance: 30 }),
});

export const occtStlExportSchema = z
  .object({ binary: z.boolean().default(true) })
  .extend(occtExportTessellationSchema.shape)
  .extend(coordinateSystemSchema.shape);

export const occtStepExportSchema = coordinateSystemSchema;

export const occtGlbExportSchema = occtExportTessellationSchema.extend(coordinateSystemSchema.shape);

export const occtGltfExportSchema = occtExportTessellationSchema.extend(coordinateSystemSchema.shape);
```

This eliminates the current wrong ownership where `opencascade.plugin.ts` imports `occtRenderOptionSchema` from `replicad.plugin.ts`, and eliminates the duplicated `occtExportTessellationSchema` definitions.

### R3: Extract shared kernel helpers to a common module (P0, Low effort, High impact)

Create `packages/runtime/src/kernels/kernel-module-helpers.ts` containing the 6 functions and 1 type duplicated across 4 kernel files: `KERNEL_MODULES_KEY`, `getModuleRegistry()`, `isRecordObject()`, `extractDefaultParameters()`, `resolveToRelative()`, `enrichIssueLocation()`, and `RuntimeModuleExports`.

### R4: Fix `renderSchema` serialization gap (P1, Low effort, High impact)

The `runtime-client.ts` maps `KernelPlugin` → `KernelModuleEntry` but drops `renderSchema`. Add it to the serialization at lines 490–498:

```typescript
const kernelModules = kernels.map((k) => ({
  id: k.id,
  moduleUrl: k.moduleUrl,
  extensions: k.extensions,
  detectImport: k.detectImport?.source,
  builtinModuleNames: k.builtinModuleNames,
  options: k.options,
  exportSchemas: k.exportSchemas,
  renderSchema: k.renderSchema, // currently missing
}));
```

Without this, the capabilities manifest's `renderOptions` array is always empty despite kernels declaring render schemas.

### R5: Fix test-d field naming divergence (P0, Low effort, Medium impact)

Reconcile `define-plugin.test-d.ts` to use the production field names (`exportSchemas` not `exportOptionSchemas`, remove `exportFormats`).

### R6: Add compile-time format exhaustiveness verification (P2, Medium effort, High impact)

The `ExportGeometryInput` discriminated union enables exhaustive switches via the `never` default pattern, but doesn't require them. A kernel author can silently drop a format from their switch without error. Investigate whether `defineKernel` can structurally require that `exportGeometry` handles all formats declared in `exportSchemas`.

## Proposed File Organization

After applying R1–R3:

```
kernels/
├── kernel-module-helpers.ts         # R3: shared helper functions
├── occt-shared-schemas.ts           # R2: shared OCCT tessellation/export schemas
├── replicad/
│   ├── replicad.schemas.ts          # R1: canonical schema declarations
│   ├── replicad.plugin.ts           # Detection + registration only
│   ├── replicad.kernel.ts           # Runtime lifecycle only
│   └── ...
├── opencascade/
│   ├── opencascade.schemas.ts       # R1: canonical schema declarations
│   ├── opencascade.plugin.ts        # Detection + registration only
│   ├── opencascade.kernel.ts        # Runtime lifecycle only
│   └── ...
├── jscad/
│   ├── jscad.schemas.ts
│   ├── jscad.plugin.ts
│   └── jscad.kernel.ts
├── manifold/
│   ├── manifold.schemas.ts
│   ├── manifold.plugin.ts
│   └── manifold.kernel.ts
├── openscad/
│   ├── openscad.schemas.ts
│   ├── openscad.plugin.ts
│   └── openscad.kernel.ts
├── tau/
│   ├── tau.schemas.ts
│   ├── tau.plugin.ts
│   └── tau.kernel.ts
└── zoo/
    ├── zoo.schemas.ts
    ├── zoo.plugin.ts
    └── zoo.kernel.ts
```

## Impact Assessment

| Area                                   | Current state                                        | After refactoring                              |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Schema drift between plugin and kernel | Silent — no compile-time link                        | Impossible — single `*.schemas.ts` declaration |
| Adding a new export format             | Update plugin + kernel, hope they match              | Update `*.schemas.ts`, both consumers get it   |
| Shared OCCT schemas                    | Wrong ownership (replicad owns, opencascade borrows) | Canonical `occt-shared-schemas.ts`             |
| Helper code duplication                | 6 functions × 4 kernels                              | Single `kernel-module-helpers.ts`              |
| Circular dependency                    | plugin ↔ kernel (type + value)                       | DAG: schemas → plugin, schemas → kernel        |
| Render option manifest                 | Broken — JSON Schema not serialized to worker        | Fixed via R4                                   |
| Understanding kernel capabilities      | Read 2 files, mentally merge                         | `*.schemas.ts` is the complete schema manifest |

## Addendum: Lazy Capabilities Manifest

The eigenquestion answer in this document concludes that dual _consumption_ of schemas is necessary (JSON Schema for the eager manifest, Zod for lazy validation) even though dual _declaration_ is avoidable via `*.schemas.ts`. A follow-up investigation, [Lazy Capabilities Manifest](lazy-capabilities-manifest.md), challenges the "dual consumption is necessary" premise itself.

The key insight: the UI never reads export capabilities before a kernel is active, and the kernel is loaded before the export dialog is shown. If the manifest is incrementally updated when a kernel module loads (via a new `'capabilitiesUpdated'` push response), the plugin registration can drop `exportSchemas` and `renderOptionSchema` entirely. The kernel module's Zod schemas become the sole source, and JSON Schema derivation moves to the worker at kernel load time.

This has implications for the recommendations in this document:

| Recommendation                                 | Impact of lazy manifest                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**: `*.schemas.ts` extraction              | Still valuable for shared schemas (OCCT), but no longer necessary for plugin-kernel schema sharing — the plugin doesn't consume schemas at all |
| **R2**: OCCT shared schemas                    | Unchanged — shared schema module for cross-kernel reuse is still needed                                                                        |
| **R3**: Helper extraction                      | Unchanged — orthogonal to manifest timing                                                                                                      |
| **R4**: `renderOptionSchema` serialization fix | **Superseded** — lazy manifest derives render option JSON Schema from the kernel definition directly, no serialization needed                  |
| **R5**: Test-d field naming                    | Unchanged — orthogonal                                                                                                                         |
| **R6**: Format exhaustiveness                  | Unchanged — orthogonal                                                                                                                         |

See [Lazy Capabilities Manifest](lazy-capabilities-manifest.md) for the full analysis, protocol design, and phased rollout plan.

## Addendum: Generic Inference Pipeline

The prior implementation plan proposed explicit `<Options, FormatMap>` type parameters to work around the partial-inference limitation documented in Finding 4. The [Generic Inference Pipeline](generic-inference-pipeline.md) research identifies a superior approach: adding an `optionsSchema` field to the plugin config so that `createKernelPlugin` can infer both `Options` (from `optionsSchema`) and `FormatMap` (from `exportSchemas`) from a single config argument with zero explicit type parameters. This eliminates the partial-inference limitation entirely and aligns with Library API Policy §16 (type-safe options helpers via inference).

## References

- Library API Policy: `docs/policy/library-api-policy.md` — §2 Define Functions, §8 Plugin Factories, §12 TypeScript-First
- Export Option Schema Architecture: `docs/research/export-option-schema-architecture.md`
- Schema-Driven Export Configuration: `docs/research/schema-driven-export-configuration.md`
- Lazy Capabilities Manifest: `docs/research/lazy-capabilities-manifest.md`
- Generic Inference Pipeline: `docs/research/generic-inference-pipeline.md`
- Type test suite: `packages/runtime/src/types/define-plugin.test-d.ts`
