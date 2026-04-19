---
title: 'Lazy Capabilities Manifest'
description: 'Architecture for incrementally updating the capabilities manifest as kernel modules are lazily loaded, eliminating the requirement for plugin-side schema duplication.'
status: draft
created: '2026-04-15'
updated: '2026-04-15'
category: architecture
related:
  - docs/research/kernel-plugin-type-linkage.md
  - docs/policy/library-api-policy.md
  - docs/research/export-option-schema-architecture.md
  - docs/research/generic-inference-pipeline.md
---

# Lazy Capabilities Manifest

Investigation into making the capabilities manifest incrementally updatable as kernel modules are lazily loaded, rather than requiring all schema data to be pre-computed and shipped with plugin registrations at initialization time.

## Executive Summary

The current architecture builds the capabilities manifest once during worker initialization, using pre-computed JSON Schema from plugin registrations. This "build it all up front" approach is the root cause of the schema duplication identified in the [Kernel–Plugin Type Linkage](kernel-plugin-type-linkage.md) research: plugins must carry schemas so the manifest can be built before kernels are loaded. If the manifest could be incrementally updated when a kernel module is lazily loaded, the plugin would no longer need to carry any schema data — the kernel module itself would be the sole schema authority. This document analyzes the feasibility of that change, the protocol additions required, the impact on UI consumers, and the trade-offs involved.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Current Lifecycle](#current-lifecycle)
- [Findings](#findings)
- [Proposed Architecture: Incremental Manifest](#proposed-architecture-incremental-manifest)
- [Trade-offs](#trade-offs)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

The [Kernel–Plugin Type Linkage](kernel-plugin-type-linkage.md) research identified that schema duplication between `*.plugin.ts` and `*.kernel.ts` exists because of a timing constraint: the capabilities manifest is built eagerly during `KernelWorker.initialize()`, before any kernel module is lazily loaded. Plugin registrations must therefore carry pre-computed JSON Schema so the manifest has data to work with.

This raises the follow-up question: **What if the manifest didn't need to be complete at initialization?** If the manifest could grow incrementally as kernels are loaded, the plugin registration could omit schemas entirely, and the kernel module would be the sole schema owner.

Three factors make this worth investigating:

1. **Schema ownership**: The `*.schemas.ts` extraction (R1 from the type-linkage research) unifies declaration but still requires both plugin and kernel to consume the schemas. A lazy manifest would let the plugin drop schema consumption entirely.
2. **Startup latency**: Converting Zod schemas to JSON Schema during `createKernelPlugin()` adds main-thread work at import time. Deferring this to the worker (at kernel load time) moves the cost off the critical path.
3. **Plugin simplicity**: Plugin registrations become pure metadata (id, moduleUrl, extensions, detect pattern) with no schema knowledge — aligning with Library API Policy §8 (Plugin Factories Return Plain Objects) and §9 (Lazy Initialization for Expensive Resources).

## Methodology

1. Traced the complete manifest lifecycle: construction in `buildCapabilitiesManifest()`, emission via the `'initialized'` response, reception in `RuntimeWorkerClient.handleMessage()`, propagation through `RuntimeClient.connect()`, and consumption in `cad.machine.ts` via the `'capabilities'` event
2. Inventoried all UI code paths that read `CapabilitiesManifest` to determine which fields are needed before vs. after the first render
3. Analyzed existing push-style protocol messages (`'stateChanged'`, `'activeKernelChanged'`) as precedent for unsolicited worker-to-client notifications
4. Evaluated the impact on the `ExportRoute` computation (which cross-joins kernel exports × transcoder edges) when kernel data arrives incrementally
5. Cross-referenced with Library API Policy §7 (Subscribe-Anytime Events), §8 (Plugin Factories), §9 (Lazy Initialization)

## Current Lifecycle

The manifest is built exactly once, synchronously, during worker initialization:

```
Main thread                              Worker thread
───────────                              ─────────────
createRuntimeClient()
  ├─ kernels.map(k => KernelModuleEntry)
  │    exportSchemas: JSON Schema  ◄──── Plugin's pre-computed JSON Schema
  │    (renderOptionSchema: MISSING ◄── Bug: not serialized)
  │
  └─ workerClient.initialize() ────────► KernelWorker.initialize()
                                           ├─ loadMiddleware()
                                           ├─ loadTranscoders()  ◄── Eager
                                           ├─ onInitialize()
                                           │    └─ Populate:
                                           │         kernelExportFormatsMap
                                           │         kernelExportOptionSchemasMap
                                           │         kernelRenderOptionSchemasMap
                                           ├─ buildCapabilitiesManifest()
                                           │    └─ Cross-join kernel exports × transcoder edges
                                           │         → CapabilitiesManifest (frozen)
                                           │
                                           └─ respond({ type: 'initialized',
                                                capabilities: manifest })
                                                      │
  _capabilities = response.capabilities ◄─────────────┘
  handlers.capabilities.forEach(h => h(manifest))
       │
       └──► cad.machine → capabilitiesUpdated → setCapabilities
                 │
                 └──► chat-converter.tsx → deriveAvailableFormats()
                                         → resolveFormatSchema()
```

Key observation: **the manifest is consumed by the UI to populate the export dialog**. The export dialog shows available formats, their option schemas, and defaults. The user cannot export until after a successful render, which means the active kernel has already been selected and loaded by the time they interact with export controls.

## Findings

### Finding 1: The export dialog is only actionable after a kernel is active

The `chat-converter.tsx` component calls `deriveAvailableFormats(capabilities, activeKernelId)`. When `activeKernelId` is `undefined`, it returns an empty array — no formats are shown. The `activeKernelId` is set only after the first render triggers `selectKernel()` → `loadKernelModule()`.

This means: **the UI does not need export capabilities before the active kernel is known**. The current eagerly-built manifest contains entries for all registered kernels, but only the active kernel's entries are ever displayed. The entries for non-active kernels are computed but unused.

```typescript
// chat-converter.tsx — only active kernel's routes are shown
function selectBestRoutes(
  capabilities: CapabilitiesManifest,
  activeKernelId: string | undefined,
): Map<FileExtension, ExportRoute> {
  if (!activeKernelId) {
    return new Map(); // Empty — nothing to show
  }
  for (const route of capabilities.exportRoutes) {
    if (route.kernelId !== activeKernelId) {
      continue; // Skip all non-active kernels
    }
    // ...
  }
}
```

### Finding 2: Existing push protocol provides the exact pattern needed

The worker already pushes unsolicited notifications to the main thread:

| Push response           | Trigger                       | Pattern                                                     |
| ----------------------- | ----------------------------- | ----------------------------------------------------------- |
| `'stateChanged'`        | Worker state transitions      | `worker.onStateChanged = (state, detail) => respond(...)`   |
| `'activeKernelChanged'` | First render selects a kernel | `worker.onActiveKernelChanged = (kernelId) => respond(...)` |
| `'log'` / `'logBatch'`  | Kernel logging                | Direct `respond(...)` calls                                 |

A `'capabilitiesUpdated'` push response follows the identical pattern. The dispatcher wires a callback during initialization; the worker invokes it whenever new capabilities emerge.

### Finding 3: The UI already handles capabilities replacement reactively

The `cad.machine.ts` listens for `'capabilitiesUpdated'` events in **every state** (connecting, idle, buffering, rendering, error). The `setCapabilities` action does a full replacement via `assign({ capabilities })`. This means the UI is already architecturally prepared for capabilities that change over time — it does not assume capabilities are set once.

### Finding 4: Manifest computation is a cross-join that grows with kernel loading

`buildCapabilitiesManifest()` performs three steps:

1. Iterate `kernelExportFormatsMap` → build `kernelExports[]`
2. Iterate `loadedTranscoders` → build `transcodeEdges[]`
3. Cross-join `kernelExports × transcodeEdges` → build `exportRoutes[]`

Step 2 (transcoder edges) is constant after initialization since transcoders are loaded eagerly. Steps 1 and 3 depend on per-kernel data. When a new kernel is loaded, its export formats and schemas become available, and the cross-join with existing transcoder edges produces new export routes.

Rebuilding the full manifest on each kernel load is O(K × T) where K is the number of kernel export entries and T is the number of transcoder edges. Given the current system has ~7 kernels with ~4 formats each (~28 entries) and ~2 transcoder edges, this is trivially cheap.

### Finding 5: `renderOptionSchema` would be naturally resolved by lazy manifest

The `renderOptionSchema` serialization bug (Finding 2 in the type-linkage research) — where the plugin's JSON Schema for render options is never sent to the worker — would be automatically resolved by a lazy manifest. Instead of relying on the plugin to pre-compute and the client to forward the render option JSON Schema, the worker would derive it directly from the kernel definition's Zod schema at `loadKernelModule` time. Single source, no serialization gap.

### Finding 6: Initial manifest can be a valid empty-kernel manifest

The initial manifest returned from `'initialized'` already has the right shape when no kernel data is available:

```typescript
private _capabilitiesManifest: CapabilitiesManifest = {
  kernelExports: [],
  transcodeEdges: [],
  exportRoutes: [],
};
```

Transcoder edges are known eagerly (transcoders load during init), so the initial manifest would contain `transcodeEdges` but empty `kernelExports` and `exportRoutes`. This is semantically correct — no kernel has been loaded yet, so no kernel-specific capabilities exist.

### Finding 7: Third-party consumers may read capabilities before kernel activation

External consumers of `@taucad/runtime` (not the Tau UI) could theoretically read `client.capabilities` immediately after `connect()` to enumerate all available formats. A lazy manifest would return a manifest with only transcoder edges initially, then grow as kernels are loaded. This is a semantic change in the public API contract.

## Proposed Architecture: Incremental Manifest

### Phase 1: Protocol — add `'capabilitiesUpdated'` push response

Add a new unsolicited response type to the runtime protocol, following the existing `'activeKernelChanged'` pattern:

```typescript
export type RuntimeResponse =
  | { type: 'initialized'; requestId: string; capabilities: CapabilitiesManifest }
  // ... existing responses ...
  | { type: 'activeKernelChanged'; kernelId: string | undefined }
  | { type: 'capabilitiesUpdated'; capabilities: CapabilitiesManifest }; // NEW
```

### Phase 2: Worker — rebuild and push manifest after kernel load

Add a callback to `KernelWorker`:

```typescript
// kernel-worker.ts
public onCapabilitiesUpdated?: (manifest: CapabilitiesManifest) => void;
```

In `KernelRuntimeWorker.loadKernelModule()`, after storing the kernel's schemas, rebuild and push:

```typescript
private async loadKernelModule(config: KernelModuleEntry, tracer: RuntimeSpanTracer): Promise<LoadedKernel> {
  // ... existing load logic ...

  if (definition.exportSchemas) {
    this.kernelExportZodSchemasMap.set(config.id, definition.exportSchemas);

    // Derive JSON Schema from the kernel's Zod schemas (single source of truth)
    const formats = Object.keys(definition.exportSchemas) as FileExtension[];
    this.kernelExportFormatsMap.set(config.id, formats);

    const optionSchemas: Partial<Record<FileExtension, ExportOptionSchema>> = {};
    for (const [format, zodSchema] of Object.entries(definition.exportSchemas)) {
      optionSchemas[format as FileExtension] = {
        schema: toJSONSchema(zodSchema) as Record<string, unknown>,
        defaults: (zodSchema.parse({}) ?? {}) as Record<string, unknown>,
      };
    }
    this.kernelExportOptionSchemasMap.set(config.id, optionSchemas);
  }

  if (definition.renderOptionSchema) {
    this.kernelRenderZodSchemaMap.set(config.id, definition.renderOptionSchema);
    this.kernelRenderOptionSchemasMap.set(config.id, {
      schema: toJSONSchema(definition.renderOptionSchema) as Record<string, unknown>,
      defaults: (definition.renderOptionSchema.parse({}) ?? {}) as Record<string, unknown>,
    });
  }

  // Rebuild and push the updated manifest
  this._capabilitiesManifest = this.buildCapabilitiesManifest();
  this.onCapabilitiesUpdated?.(this._capabilitiesManifest);

  return loaded;
}
```

### Phase 3: Dispatcher — wire the callback

In `runtime-worker-dispatcher.ts`, wire the callback alongside `onActiveKernelChanged`:

```typescript
worker.onCapabilitiesUpdated = (capabilities) => {
  respond({ type: 'capabilitiesUpdated', capabilities });
};
```

### Phase 4: Client — handle the push and re-emit

In `RuntimeWorkerClient.handleMessage()`:

```typescript
case 'capabilitiesUpdated': {
  this._capabilities = response.capabilities;
  this.onCapabilitiesUpdatedCb?.(response.capabilities);
  break;
}
```

In `RuntimeClient.connect()`, wire the callback:

```typescript
onCapabilitiesUpdated(capabilities) {
  _capabilities = capabilities;
  for (const handler of handlers.capabilities) {
    handler(capabilities);
  }
},
```

### Phase 5: Simplify plugin registrations

With the worker deriving all JSON Schema from kernel Zod schemas at load time, the plugin registration no longer needs `exportSchemas` or `renderOptionSchema`:

```typescript
// Before: plugin carries pre-computed JSON Schema
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
  renderOptionSchema: replicadRenderOptionSchema, // Can be removed
  exportSchemas: replicadExportSchemas, // Can be removed
});

// After: plugin is pure metadata
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
});
```

### Phase 6: Eliminate redundant schema maps

The five parallel schema maps in `KernelWorker` collapse to two:

| Before (5 maps)                                            | After (2 maps)                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `kernelExportFormatsMap` (eager, plugin)                   | Derived from `kernelExportZodSchemasMap` keys                   |
| `kernelExportOptionSchemasMap` (eager, plugin JSON Schema) | Derived from `kernelExportZodSchemasMap` at manifest build time |
| `kernelRenderOptionSchemasMap` (eager, plugin JSON Schema) | Derived from `kernelRenderZodSchemaMap` at manifest build time  |
| `kernelExportZodSchemasMap` (lazy, kernel Zod)             | **Kept** — canonical source                                     |
| `kernelRenderZodSchemaMap` (lazy, kernel Zod)              | **Kept** — canonical source                                     |

The JSON Schema derivation moves inside `buildCapabilitiesManifest()`, called each time a kernel loads.

## Trade-offs

| Dimension                         | Eager manifest (current)                            | Lazy manifest (proposed)                                  |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| **Manifest completeness at init** | All registered kernels represented                  | Only transcoder edges; kernel entries appear on load      |
| **Schema ownership**              | Dual: plugin (JSON Schema) + kernel (Zod)           | Single: kernel (Zod) only                                 |
| **Plugin complexity**             | Carries `exportSchemas` + `renderOptionSchema`      | Pure metadata — id, url, extensions, detect               |
| **`createKernelPlugin` work**     | Converts Zod → JSON Schema at import time           | No schema conversion; plugin is a plain object literal    |
| **Main-thread import cost**       | Zod schemas + `toJSONSchema` execute on main thread | Only metadata — no Zod, no `toJSONSchema`                 |
| **Manifest build cost**           | Once during init                                    | Once during init + once per kernel load (trivially cheap) |
| **`renderOptionSchema` bug**      | Requires explicit fix (R4)                          | Automatically resolved — derived from kernel              |
| **Schema drift risk**             | Possible if plugin and kernel diverge               | Impossible — single Zod source in kernel                  |
| **API contract change**           | N/A                                                 | `capabilities` may be incomplete before first render      |
| **Third-party consumers**         | See all formats immediately after connect           | Must subscribe to `'capabilities'` event for updates      |
| **Protocol messages**             | No additional messages                              | One `'capabilitiesUpdated'` per kernel load               |

### API contract considerations

The key trade-off is the semantic change for third-party consumers of `client.capabilities`:

- **Current**: After `connect()`, `capabilities` contains the complete manifest for all registered kernels.
- **Proposed**: After `connect()`, `capabilities` contains only transcoder edges. Kernel-specific entries appear incrementally after `on('capabilities', ...)` events.

This aligns with Library API Policy §7 (Subscribe-Anytime Events) and §9 (Lazy Initialization). The `on('capabilities', handler)` API already exists and would simply fire more frequently. The Tau UI already handles this correctly (Finding 3).

For third-party consumers who do need all capabilities upfront, a convenience method could be provided:

```typescript
// Wait until the specified kernel's capabilities are available
const manifest = await client.waitForCapabilities('replicad');
```

Alternatively, a `future` flag (per API Evolution Policy §1) could gate the behavior:

```typescript
const client = createRuntimeClient({
  kernels: [replicad()],
  future: {
    unstable_lazyCapabilities: true,
  },
});
```

## Recommendations

| #   | Action                                                                    | Priority | Effort | Impact                                   |
| --- | ------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------- |
| R1  | Add `'capabilitiesUpdated'` push response to the protocol                 | P0       | Low    | Foundation for all other changes         |
| R2  | Wire `onCapabilitiesUpdated` callback in worker → dispatcher → client     | P0       | Low    | Enables push-based manifest updates      |
| R3  | Derive JSON Schema from kernel Zod schemas in `loadKernelModule`          | P0       | Medium | Eliminates plugin-side schema dependency |
| R4  | Rebuild and push manifest after each `loadKernelModule` call              | P0       | Low    | Makes manifest incrementally accurate    |
| R5  | Remove `exportSchemas` and `renderOptionSchema` from `KernelPluginConfig` | P1       | Medium | Simplifies plugin API surface            |
| R6  | Collapse 5 schema maps to 2 in `KernelWorker`                             | P1       | Medium | Reduces internal complexity              |
| R7  | Add `future.unstable_lazyCapabilities` flag for opt-in rollout            | P2       | Low    | Protects third-party consumers           |

### Phased rollout

The recommendations can be implemented in two phases:

**Phase A (additive, non-breaking)**: R1–R4. Add the push protocol, derive kernel schemas lazily, rebuild manifest on kernel load. Plugin schemas remain but become redundant. The initial manifest continues to contain plugin-derived data; the push updates augment/replace it with kernel-derived data. No external API change.

**Phase B (simplification, potentially breaking)**: R5–R7. Remove schema fields from plugin config, collapse internal maps, gate behind a future flag. This is the "cleanup" phase that realizes the full simplification.

## Code Examples

### Minimal protocol change (R1)

```typescript
// runtime-protocol.types.ts
export type RuntimeResponse =
  | { type: 'initialized'; requestId: string; capabilities: CapabilitiesManifest }
  // ... existing ...
  | { type: 'capabilitiesUpdated'; capabilities: CapabilitiesManifest };
```

### Worker callback (R2)

```typescript
// kernel-worker.ts
public onCapabilitiesUpdated?: (manifest: CapabilitiesManifest) => void;

protected rebuildAndPushCapabilities(): void {
  this._capabilitiesManifest = this.buildCapabilitiesManifest();
  this.onCapabilitiesUpdated?.(this._capabilitiesManifest);
}
```

### Kernel load triggers manifest rebuild (R3–R4)

```typescript
// kernel-runtime-worker.ts — loadKernelModule
private async loadKernelModule(
  config: KernelModuleEntry,
  tracer: RuntimeSpanTracer,
): Promise<LoadedKernel> {
  // ... existing dynamic import + validation ...

  if (definition.exportSchemas) {
    this.kernelExportZodSchemasMap.set(config.id, definition.exportSchemas);

    const formats = Object.keys(definition.exportSchemas) as FileExtension[];
    this.kernelExportFormatsMap.set(config.id, formats);

    const optionSchemas: Partial<Record<FileExtension, ExportOptionSchema>> = {};
    for (const [format, schema] of Object.entries(definition.exportSchemas)) {
      try {
        optionSchemas[format as FileExtension] = {
          schema: toJSONSchema(schema) as Record<string, unknown>,
          defaults: (schema.parse({}) ?? {}) as Record<string, unknown>,
        };
      } catch {
        this.logger.warn(`Failed to convert export schema for ${config.id}:${format}`);
      }
    }
    this.kernelExportOptionSchemasMap.set(config.id, optionSchemas);
  }

  if (definition.renderOptionSchema) {
    this.kernelRenderZodSchemaMap.set(config.id, definition.renderOptionSchema);
    try {
      this.kernelRenderOptionSchemasMap.set(config.id, {
        schema: toJSONSchema(definition.renderOptionSchema) as Record<string, unknown>,
        defaults: (definition.renderOptionSchema.parse({}) ?? {}) as Record<string, unknown>,
      });
    } catch {
      this.logger.warn(`Failed to convert render option schema for ${config.id}`);
    }
  }

  this.rebuildAndPushCapabilities();
  return loaded;
}
```

### Simplified plugin (R5 — after Phase B)

```typescript
// replicad.plugin.ts — no schema imports needed
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
});
```

## Diagrams

### Proposed incremental manifest flow

```
Main thread                              Worker thread
───────────                              ─────────────
createRuntimeClient()
  ├─ kernels.map(k => ({
  │    id, moduleUrl, extensions,
  │    detectImport, options           ◄── No schemas in plugin
  │  }))
  │
  └─ workerClient.initialize() ────────► KernelWorker.initialize()
                                           ├─ loadMiddleware()
                                           ├─ loadTranscoders()
                                           ├─ onInitialize()        ◄── No kernel schemas to store
                                           ├─ buildCapabilitiesManifest()
                                           │    └─ { kernelExports: [],
                                           │         transcodeEdges: [...],  ◄── Transcoders known
                                           │         exportRoutes: [] }
                                           │
  capabilities = { transcodeEdges } ◄──── respond('initialized', manifest)
                                           │
                                           │ ... user opens a .ts file ...
                                           │
                                           ├─ selectKernel('main.ts')
                                           │    └─ loadKernelModule('replicad')
                                           │         ├─ import(moduleUrl)
                                           │         ├─ Store Zod schemas
                                           │         ├─ Derive JSON Schema from Zod
                                           │         ├─ Rebuild manifest (with replicad entries)
                                           │         └─ onCapabilitiesUpdated(manifest)
                                           │                    │
  capabilities = { full manifest } ◄────── respond('capabilitiesUpdated', manifest)
  handlers.capabilities.forEach(...)
       │
       └──► cad.machine → capabilitiesUpdated → setCapabilities
                 │
                 └──► Export dialog now populated with replicad formats
```

### Timing relationship: kernel load vs. export dialog

```
Timeline ────────────────────────────────────────────────────►

  connect()        first render        user clicks Export
     │                  │                       │
     ▼                  ▼                       ▼
  ┌──────┐  ┌───────────────────┐  ┌────────────────────┐
  │ init │  │ selectKernel +    │  │ Export dialog reads │
  │      │  │ loadKernelModule  │  │ capabilities for   │
  │      │  │ + manifest push   │  │ active kernel      │
  └──────┘  └───────────────────┘  └────────────────────┘
     │              │                        │
     │              │  ◄── capabilities      │
     │              │      available here    │
     │              │                        │
     │              └──── ALWAYS before ─────┘
     │                    export dialog
     │
     └── manifest has only transcoder edges (fine — no kernel active)
```

The user cannot interact with the export dialog until after a render completes (which requires kernel selection + load). The `'capabilitiesUpdated'` push is emitted during `loadKernelModule`, which happens during `selectKernel`, which is the first step of the render pipeline. The manifest is always updated before the user can see the export dialog.

## Addendum: Generic Inference Pipeline

The [Generic Inference Pipeline](generic-inference-pipeline.md) research resolves the type propagation question left open by R5 (plugin simplification). By adding an `optionsSchema` field to the plugin config, `createKernelPlugin` infers both `Options` and `FormatMap` from the config object with zero explicit type parameters. The `exportSchemas` remain in the plugin config as type-only inference sources (not converted to JSON Schema on the main thread), while the worker derives JSON Schema lazily from the kernel definition's schemas as described in R3/R4.

## References

- Kernel–Plugin Type Linkage: `docs/research/kernel-plugin-type-linkage.md`
- Library API Policy: `docs/policy/library-api-policy.md` — §7 Subscribe-Anytime Events, §8 Plugin Factories, §9 Lazy Initialization
- API Evolution Policy: `docs/policy/api-evolution-policy.md` — §1 Future Flags
- Export Option Schema Architecture: `docs/research/export-option-schema-architecture.md`
- Generic Inference Pipeline: `docs/research/generic-inference-pipeline.md`
