---
title: 'Export Pipeline v3'
description: 'Pluggable conversion architecture for runtime export/import routing: kernel-native first, transcoder plugins for fallback, worker-side capability discovery, and no hardcoded GLB or converter dependency in core runtime'
status: superseded
superseded_by: docs/research/export-pipeline-v4.md
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/export-pipeline-v2.md
  - docs/research/unified-export-pipeline-architecture.md
  - docs/research/schema-driven-export-configuration.md
  - docs/research/converter-runtime-consolidation.md
  - docs/policy/library-api-policy.md
  - docs/research/parameter-architecture-v2.md
---

# Export Pipeline v3

Architecture revision for export/import routing in `@taucad/runtime` that preserves v2 wins (schema-driven config, worker discovery, type-safe formats) while replacing hardwired GLB/converter fallback with a pluggable transcoder model that supports multiple concurrent providers (including commercial providers such as Zoo).

This document supersedes `docs/research/export-pipeline-v2.md`.

## Executive Summary

v2 successfully unified terminology, schema flow, and capability discovery, but it still encoded one structural assumption: framework fallback always means `kernel -> glb -> exportFromGlb` using `@taucad/converter`. That assumption blocks concurrent converter providers, hardcodes GLB as the universal bridge format, and places provider-specific behavior inside runtime core.

v3 keeps runtime as the orchestrator but moves conversion engines behind a new plugin primitive: **transcoder plugins**. Kernels remain responsible for geometry evaluation and native exports; transcoders are responsible for bytes-to-bytes format conversion. The framework plans and executes routes across both capability sets, preferring direct kernel export, then provider routes. This supports:

1. No hardcoded intermediate format (`glb` is one option, not a requirement)
2. Multiple import/export-only providers active at once
3. Dynamic provider capabilities (including commercial APIs discovered at startup and validated at export time)
4. Converter decoupling from runtime core (converter becomes a provider plugin, not a baked-in framework dependency)

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Trade-off Evaluation](#trade-off-evaluation)
- [v3 Target Architecture](#v3-target-architecture)
- [Core Primitives and Contracts](#core-primitives-and-contracts)
- [Capability Discovery and Manifest v3](#capability-discovery-and-manifest-v3)
- [Route Planning and Execution](#route-planning-and-execution)
- [Commercial Provider Fit (Zoo Example)](#commercial-provider-fit-zoo-example)
- [Import Path Symmetry](#import-path-symmetry)
- [What v2 Keeps vs Changes](#what-v2-keeps-vs-changes)
- [Migration Plan (v2 -> v3)](#migration-plan-v2---v3)
- [Recommendations](#recommendations)
- [Risks and Mitigations](#risks-and-mitigations)
- [References](#references)

## Problem Statement

The architecture must satisfy all of the following simultaneously:

1. Runtime remains the single orchestrator of 3D workflows
2. Kernel-native export remains first-class and preferred
3. Fallback conversion must not hardcode a single intermediate format
4. Fallback conversion must not hardcode `@taucad/converter` into framework internals
5. Multiple providers may coexist concurrently (open-source + commercial + import-only + export-only)
6. Provider source/target capabilities may be unknown until startup or vary at runtime
7. UI capability rendering remains dynamic and schema-driven
8. API shape follows `docs/policy/library-api-policy.md` (factory + define contracts, flat options, predictable naming)

v2 violated (3) and (4) by proposing direct framework fallback to `exportFromGlb` and implicitly assuming GLB as the only bridge format.

## Methodology

This investigation used direct source audit of runtime contracts and call flow:

- `packages/runtime/src/client/runtime-client.ts`
- `packages/runtime/src/framework/runtime-worker-client.ts`
- `packages/runtime/src/framework/runtime-worker-dispatcher.ts`
- `packages/runtime/src/framework/kernel-worker.ts`
- `packages/runtime/src/types/runtime-kernel.types.ts`
- `packages/runtime/src/types/runtime-protocol.types.ts`
- `packages/runtime/src/types/runtime-middleware.types.ts`
- `packages/runtime/src/plugins/plugin-types.ts`
- `packages/runtime/src/plugins/plugin-helpers.ts`
- `packages/runtime/src/plugins/kernel-factories.ts`
- `packages/runtime/src/kernels/tau/tau.kernel.ts`
- `packages/runtime/src/kernels/zoo/zoo.kernel.ts`
- `packages/converter/src/conversion.ts`
- `packages/converter/src/formats.ts`
- `docs/policy/library-api-policy.md`
- `docs/research/export-pipeline-v2.md`

## Findings

### Finding 1: Current runtime core is converter-agnostic, but v2 reintroduces converter coupling in design

Evidence from code:

- `KernelWorker.exportGeometry` orchestrates middleware + kernel dispatch, with no converter import.
- `RuntimeWorkerClient` and dispatcher transport `export` messages only (`format`, `tessellation`), no converter API.
- Converter use is localized to specific modules (`tau.kernel.ts`, glTF middleware, UI hooks).

Implication: hardwiring `exportFromGlb` in framework core is a regression in coupling model, not a requirement of current architecture.

### Finding 2: GLB-only fallback is a strategic bottleneck

The path `kernel.export(glb) -> exportFromGlb(glb, target)` assumes:

- All kernels can produce GLB with acceptable fidelity
- All providers consume GLB
- GLB is the best bridge for all targets

These assumptions break for:

- Providers that accept STEP/BREP but not GLB
- Providers that do best with OBJ/USD/IGES intermediates
- Future routes where direct BREP-preserving conversion is preferred over mesh bridge

### Finding 3: Middleware is the wrong primitive for conversion route planning

`wrapExportGeometry(input, handler, runtime)` is ideal for cross-cutting concerns (logging, tracing, cache, transforms around one operation). It is not ideal for:

- Multi-provider route resolution
- Provider capability discovery and graph planning
- Multi-hop conversion execution and fallback retries

Using middleware for routing would overload interception with orchestration responsibilities.

### Finding 4: Kernel-only modeling cannot cleanly represent conversion-only providers

Treating every external converter as a kernel forces fake geometry lifecycles (`createGeometry`, `nativeHandle`, kernel selection semantics) for systems that are truly bytes-to-bytes conversion services.

This creates conceptual leakage:

- Conversion provider is not a geometry evaluator
- Conversion provider may not need `canHandle` by source file extension in the kernel sense
- Conversion provider capability is about `(fromFormat -> toFormat)`, not code compilation unit evaluation

### Finding 5: Runtime still needs embedded orchestration logic

Moving conversion engines to plugins does not eliminate framework logic; it clarifies it:

- Framework owns capability aggregation
- Framework owns route planning
- Framework owns execution policy and deterministic tie-breakers
- Framework owns error mapping and fallback progression

So the best architecture is not “all in middleware” and not “all in plugins”; it is **plugins for capabilities + framework planner for orchestration**.

### Finding 6: Dynamic capability discovery must include providers, not just kernels

v2 discovery focuses on kernel export schemas. With concurrent providers, startup discovery must also include:

- Provider conversion edges
- Provider option schemas
- Route matrix per active kernel and target format

UI and API consumers should derive availability from this aggregated manifest, not static format lists.

## Trade-off Evaluation

| Option | Description                                                 | Pros                                                                | Cons                                                                                 | Verdict       |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| A      | Hardcoded framework fallback (`kernel -> glb -> converter`) | Simple initial implementation                                       | Hardcoded GLB, hard converter dependency, poor extensibility                         | Reject        |
| B      | Export routing in middleware                                | Reuses existing hook                                                | Overloads middleware concern, brittle chain composition, hard deterministic planning | Reject        |
| C      | Model providers as kernels only                             | Reuses `defineKernel`                                               | Semantic mismatch for conversion-only services, forces fake kernel lifecycle         | Reject        |
| D      | New transcoder plugin primitive + framework planner         | Clear separation, multi-provider support, no hardcoded intermediate | Adds one new plugin contract + planner complexity                                    | **Recommend** |

## v3 Target Architecture

### High-level model

1. **Kernels** own geometry lifecycle (`createGeometry`, native handle, native export)
2. **Transcoders** own bytes-to-bytes conversion edges (`from` -> `to`)
3. **Middleware** remains cross-cutting interception around operations
4. **Framework planner** computes and executes export/import routes using kernel + transcoder capabilities

### Mental model

```text
UI export request
  -> RuntimeClient.export(targetFormat, options)
    -> Worker export planner
      -> Try direct kernel export(targetFormat)
      -> Else plan route:
           kernel export(sourceFormat) -> transcoder hop(s) -> targetFormat
      -> Execute deterministic best route
      -> Return files + issues + route metadata
```

No hardcoded `glb`. No hardcoded converter import in runtime core.

## Core Primitives and Contracts

### 1) Kernel plugin (retained, with export capability metadata)

Main-thread registration remains plain-object factory output, with serializable capability hints for type inference and discovery:

```typescript
type KernelPlugin<F extends readonly string[] = readonly string[]> = {
  id: string;
  moduleUrl: string;
  extensions: string[];
  detectImport?: RegExp;
  builtinModuleNames?: string[];
  options?: Record<string, unknown>;
  exportFormats: F;
};
```

Worker-side kernel module continues exporting Zod export schemas (`exportSchemas`) for JSON Schema conversion.

### 2) New transcoder plugin registration (main thread)

```typescript
type TranscoderPlugin<
  From extends readonly string[] = readonly string[],
  To extends readonly string[] = readonly string[],
> = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
  fromFormats: From | ['*'];
  toFormats: To | ['*'];
  priority?: number;
};
```

Consumer config stays factory-based:

```typescript
const client = createRuntimeClient({
  kernels: [replicad(), zoo()],
  transcoders: [converterTranscoder(), zooCloudTranscoder({ apiKey })],
  middleware: [parameterCache(), geometryCache()],
});
```

### 3) New transcoder definition contract (worker module)

Following policy section 2 (`defineX`) and section 4 (predictable parameter conventions):

```typescript
type TranscoderDefinition<Context = unknown, Options extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  version: string;
  optionsSchema: z.ZodType<Options>;

  initialize(input: { options: Options }, runtime: KernelRuntime): Promise<Context>;

  discoverCapabilities(
    input: { fromFormats: readonly string[] | ['*']; toFormats: readonly string[] | ['*'] },
    runtime: KernelRuntime,
    context: Context,
  ): Promise<{
    edges: Array<{
      from: string;
      to: string;
      fidelity: 'brep' | 'mesh';
      optionsSchema?: z.ZodType;
      cost?: number;
    }>;
  }>;

  canTranscode(
    input: { from: string; to: string },
    runtime: KernelRuntime,
    context: Context,
  ): Promise<{ supported: boolean; reason?: string }>;

  transcode(
    input: { from: string; to: string; files: ExportFile[]; options?: Record<string, unknown> },
    runtime: KernelRuntime,
    context: Context,
  ): Promise<ExportGeometryResult>;

  cleanup(context: Context): Promise<void>;
};
```

Rationale:

- `discoverCapabilities` supports startup manifest generation
- `canTranscode` supports runtime dynamic checks (license, outage, account tier)
- `transcode` executes conversion edge(s)
- `cleanup` is required to avoid optional-interface ambiguity

### 4) What belongs where

| Concern                     | Kernel | Transcoder | Middleware | Framework Core |
| --------------------------- | ------ | ---------- | ---------- | -------------- |
| Evaluate geometry/code      | Yes    | No         | No         | Orchestrates   |
| Native export from handle   | Yes    | No         | Wrap only  | Orchestrates   |
| Bytes format conversion     | No     | Yes        | No         | Orchestrates   |
| Cross-cutting logging/cache | No     | No         | Yes        | Provides hooks |
| Route planning              | No     | No         | No         | Yes            |

## Capability Discovery and Manifest v3

### Worker startup discovery

During initialization, worker imports:

1. Kernel modules
2. Transcoder modules

Then it:

1. Converts all Zod schemas (kernel + transcoder option schemas) to JSON Schema
2. Computes route candidates from kernel exports + transcoder edges
3. Emits one manifest in `initialized`

Zod remains worker-only. Main thread receives JSON Schema only.

### Manifest shape

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
  priority: number;
  cost: number;
};

type ExportRouteCapability = {
  kernelId: string;
  targetFormat: string;
  routeId: string;
  sourceFormat: string;
  hops: Array<{ transcoderId: string; from: string; to: string }>;
  fidelity: 'brep' | 'mesh';
  score: number;
};

type CapabilitiesManifestV3 = {
  kernelExports: ExportFormatCapability[];
  transcodeEdges: TranscodeEdgeCapability[];
  exportRoutes: ExportRouteCapability[];
};
```

The `RuntimeClient` exposes `capabilities` as this manifest shape and emits `capabilities` event after connect.

## Route Planning and Execution

### Planning rules

For `client.export(targetFormat, options)` on an active kernel:

1. If active kernel has native `targetFormat`, prefer direct route
2. Else build candidates from:
   - each kernel source format in `kernel.exportFormats`
   - transcoder edges from manifest
3. Filter candidates with `canTranscode` checks (runtime dynamic validity)
4. Rank routes:
   - Highest fidelity first (`brep` > `mesh`)
   - Fewer hops
   - Lower total cost
   - Higher transcoder priority
   - Stable tie-break by `routeId`
5. Execute best route; on failure with retryable provider error, try next route

### No hardcoded intermediate format

The first leg is chosen by route planning, not by constant:

- `step -> zooCloud -> usdz`
- `glb -> converterTranscoder -> stl`
- `iges -> vendorX -> step`

Any source format in the kernel’s native export set can be route origin.

### Execution sketch

```typescript
async function exportWithPlanner(targetFormat: string, requestOptions: Record<string, unknown>) {
  const routes = planner.getRoutes({
    kernelId: activeKernel.id,
    targetFormat,
  });

  for (const route of routes) {
    const first = await activeKernel.exportGeometry({
      format: route.sourceFormat,
      options: selectKernelOptions(requestOptions, route),
    });
    if (!first.success) continue;

    let files = first.data;
    let failed = false;
    for (const hop of route.hops) {
      const transcoder = registry.getTranscoder(hop.transcoderId);
      const allowed = await transcoder.canTranscode({ from: hop.from, to: hop.to }, runtime, transcoder.context);
      if (!allowed.supported) {
        failed = true;
        break;
      }

      const converted = await transcoder.transcode(
        {
          from: hop.from,
          to: hop.to,
          files,
          options: selectTranscoderOptions(requestOptions, hop),
        },
        runtime,
        transcoder.context,
      );
      if (!converted.success) {
        failed = true;
        break;
      }
      files = converted.data;
    }

    if (!failed) return { success: true, data: files };
  }

  return createNoRouteError(activeKernel.id, targetFormat);
}
```

## Commercial Provider Fit (Zoo Example)

### Why Zoo exporter does not fit kernel-native fallback alone

A commercial exporter service can be:

- conversion-only (no geometry evaluation)
- dynamic in capability (plan tier, account, server-side feature toggles)
- broad in format graph (`from:any -> to:any subset`)

That shape is a transcoder concern, not a kernel concern.

### Zoo cloud transcoder plugin example

```typescript
export const zooCloudTranscoder = createTranscoderPlugin<ZooCloudOptions>({
  id: 'zoo-cloud',
  moduleUrl: new URL('../transcoders/zoo-cloud/zoo-cloud.transcoder.js', import.meta.url).href,
  fromFormats: ['*'],
  toFormats: ['*'],
});
```

Worker module:

```typescript
export default defineTranscoder({
  name: 'ZooCloudTranscoder',
  version: '1.0.0',
  optionsSchema: zooCloudOptionsSchema,
  async initialize({ options }, runtime) {
    return createZooClient(options);
  },
  async discoverCapabilities(_input, _runtime, context) {
    const matrix = await context.getConversionMatrix();
    return { edges: matrix.edges };
  },
  async canTranscode({ from, to }, _runtime, context) {
    return context.canConvert(from, to);
  },
  async transcode({ from, to, files, options }, _runtime, context) {
    return context.convert({ from, to, files, options });
  },
  async cleanup(context) {
    await context.dispose();
  },
});
```

This supports “unknown until export time” because `canTranscode` is checked at request execution, while discovery provides an initial capability snapshot for UI.

## Import Path Symmetry

v3 intentionally uses the same transcoder primitive for import and export:

- **Export**: `kernel native format -> transcoder hops -> target format`
- **Import**: `source file format -> transcoder hops -> kernel-ingest format`

This enables import-only providers (e.g., proprietary CAD loader services) without introducing separate ad-hoc interfaces.

Import route planning can be phased in after export migration without changing plugin primitives.

## What v2 Keeps vs Changes

### Kept from v2

1. Worker-only Zod authoring, JSON Schema interop for all downstream consumers
2. Type-safe plugin declarations for format unions
3. Dynamic capability discovery emitted during initialization
4. `options`-centric export configuration (including tessellation)
5. `fidelity` terminology (`brep` vs `mesh`)
6. UI derived from manifest, not static format lists
7. `.tau/export/preferences.json` persistence
8. Per-CU runtime ownership model (no `compilationUnit` arg on `client.export()`)

### Changed from v2

1. Remove hardcoded framework dependency on `exportFromGlb`
2. Remove hardcoded GLB fallback path assumption
3. Introduce first-class transcoder plugin primitive
4. Introduce framework route planner over kernel + transcoder capability graph
5. Make converter one provider among many (first-party plugin), not framework internals

## Migration Plan (v2 -> v3)

### Phase 0: Document and contract alignment

- Add `TranscoderPlugin` registration type and `createTranscoderPlugin()` factory
- Add `defineTranscoder()` worker contract
- Add `transcoders` field to `RuntimeClientOptions`

### Phase 1: Discovery and manifest v3

- Worker loads transcoder modules on startup
- Convert transcoder Zod schemas to JSON Schema in worker
- Emit `CapabilitiesManifestV3` in `initialized`

### Phase 2: Export protocol and planner

- Extend export command payload from tessellation-only to `options`
- Implement route planner and deterministic route ranking
- Execute direct kernel route first, then transcoder routes

### Phase 3: First-party converter provider extraction

- Implement `converterTranscoder` plugin wrapping `@taucad/converter`
- Remove converter fallback logic from framework core
- Keep Tau kernel as a separate kernel plugin only where needed

### Phase 4: UI and hooks consolidation

- Migrate chat converter, AR, and `@taucad/react` export hooks to runtime-only export path
- Remove direct main-thread `exportFromGlb` use outside standalone converter route

### Phase 5: Optional package decoupling

- Move converter-backed plugins to a dedicated package if full core-runtime decoupling is desired
- Keep `@taucad/runtime` core free of converter runtime dependency

## Recommendations

| #   | Action                                                                                        | Priority | Effort | Impact |
| --- | --------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Introduce `TranscoderPlugin` + `defineTranscoder` as first-class runtime primitives           | P0       | Medium | High   |
| R2  | Keep middleware focused on cross-cutting concerns; do not place route planning in middleware  | P0       | Low    | High   |
| R3  | Implement framework route planner over kernel export formats + transcoder edges               | P0       | High   | High   |
| R4  | Extend capability discovery to include transcoder edges and precomputed routes                | P0       | Medium | High   |
| R5  | Keep worker-only Zod authoring and JSON Schema manifest model for kernel + transcoder schemas | P0       | Medium | High   |
| R6  | Move converter fallback out of framework core into a provider plugin (`converterTranscoder`)  | P0       | Medium | High   |
| R7  | Preserve direct-native preference policy (`kernel native` before routed fallback)             | P0       | Low    | High   |
| R8  | Add runtime dynamic route validation (`canTranscode`) for commercial/dynamic providers        | P1       | Medium | High   |
| R9  | Expose route metadata in export results for observability/debuggability                       | P1       | Low    | Medium |
| R10 | Plan import-route orchestration using the same transcoder primitive (phase after export)      | P2       | Medium | Medium |

## Risks and Mitigations

| Risk                                              | Impact | Mitigation                                                                                    |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Planner complexity increases implementation scope | Medium | Start with single-hop routing; add multi-hop in phase 2b                                      |
| Capability drift between startup and runtime      | Medium | Require `canTranscode` runtime check before each hop                                          |
| Provider schema conflicts for same target format  | Medium | Namespaced route-level options (`options.routes[routeId]`) and merged JSON Schema oneOf       |
| Performance regressions with remote providers     | Medium | Route scoring includes provider cost/latency metadata; allow user/provider preference pinning |
| Ambiguous deterministic behavior                  | High   | Stable sorting policy and explicit route IDs in logs/errors                                   |

## References

- Export Pipeline v2: `docs/research/export-pipeline-v2.md`
- Library API Policy: `docs/policy/library-api-policy.md`
- Unified Export Pipeline Architecture: `docs/research/unified-export-pipeline-architecture.md`
- Schema-Driven Export Configuration: `docs/research/schema-driven-export-configuration.md`
- Converter Runtime Consolidation: `docs/research/converter-runtime-consolidation.md`
- Runtime kernel types: `packages/runtime/src/types/runtime-kernel.types.ts`
- Runtime protocol: `packages/runtime/src/types/runtime-protocol.types.ts`
- Runtime middleware types: `packages/runtime/src/types/runtime-middleware.types.ts`
- Plugin types/helpers: `packages/runtime/src/plugins/plugin-types.ts`, `packages/runtime/src/plugins/plugin-helpers.ts`
- Tau kernel: `packages/runtime/src/kernels/tau/tau.kernel.ts`
- Zoo kernel: `packages/runtime/src/kernels/zoo/zoo.kernel.ts`
- Converter conversion APIs: `packages/converter/src/conversion.ts`, `packages/converter/src/formats.ts`

## Appendix

### A. Naming Alignment (v3)

| Concept          | Kernel Layer         | Transcoder Layer     | Framework Planner   | Client API                 | Protocol          |
| ---------------- | -------------------- | -------------------- | ------------------- | -------------------------- | ----------------- |
| Target format    | `input.format`       | `input.to`           | `targetFormat`      | `export(format, options?)` | `command.format`  |
| Source format    | kernel-native output | `input.from`         | `sourceFormat`      | implicit                   | route metadata    |
| Format options   | `input.options`      | `input.options`      | `select*Options()`  | `options`                  | `command.options` |
| Schema authoring | Zod (worker module)  | Zod (worker module)  | n/a                 | n/a                        | n/a               |
| Schema interop   | JSON Schema manifest | JSON Schema manifest | merged route schema | RJSF                       | serialized        |

### B. Why not `defineExporterProvider` as proposed in v2

`defineExporterProvider` still over-specializes around export and does not naturally represent import-only providers or general conversion graph edges. `defineTranscoder` is direction-agnostic and supports both workflows with one primitive.

### C. Compatibility posture

This architecture is a forward rollout with no public compatibility guarantees required at this stage. API and protocol renames should prioritize conceptual correctness over compatibility shims.
