---
title: 'Transcoder Edge Source-Format Type Merging'
description: 'Type system deviation where transcoded export options miss kernel source-format options that are available at runtime'
status: draft
created: '2026-04-16'
updated: '2026-04-16'
category: investigation
related:
  - docs/research/runtime-client-type-safety-audit.md
  - docs/policy/library-api-policy.md
  - docs/policy/typescript-policy.md
---

# Transcoder Edge Source-Format Type Merging

Investigate the type-system/runtime deviation where transcoded exports (e.g., GLB→USDZ) expose merged options at runtime (kernel source-format options + transcoder edge options) but the type system only carries the transcoder edge options.

## Executive Summary

When exporting to a transcoded format like USDZ, the runtime correctly merges the kernel's intermediate format options (tessellation, coordinateSystem from the GLB schema) with the transcoder's edge-specific options (quality). The UI reflects this merged schema via `mergeJsonSchemas()` on the capabilities manifest. However, the type system treats transcoder edge options in isolation — `ExportMap['usdz']` resolves to `{ quality: number }` instead of `{ quality: number; tessellation: ...; coordinateSystem: ... }`. This makes the type system less safe than the runtime: valid options that work at runtime fail to compile.

## Problem Statement

A failing test demonstrates the gap:

```typescript
const k1 = createKernelPlugin({
  id: 'k1',
  moduleUrl: 'k1.js',
  extensions: ['ts'],
  exportSchemas: { glb: glbSchema }, // tessellation + coordinateSystem
});

const t1 = createTranscoderPlugin({
  id: 't1',
  moduleUrl: 't1.js',
  edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
});

const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });

// FAILS: 'tessellation' does not exist in type '{ quality: number }'
void client.export('usdz', {
  quality: 0.5,
  tessellation: { linearTolerance: 0.1 },
});
```

At runtime this works correctly — the worker validates `tessellation` against the GLB kernel schema and `quality` against the transcoder edge schema independently.

## Methodology

1. Traced the compile-time type flow from `createKernelPlugin` / `createTranscoderPlugin` through `CollectFormatMap`, `CollectTranscodeMap`, `MergeExportMap`, to `RuntimeClient.export()`
2. Traced the runtime flow through `KernelWorker.exportGeometry()` → `executeExportWithRoute()` → `mergeJsonSchemas()`
3. Analyzed the structural mismatch: what information is available at compile time vs. what is only known at runtime
4. Identified possible type-level solutions and their trade-offs

## Findings

### Finding 1: The Runtime Merges Source + Edge Options into a Single Bag

In `kernel-worker.ts`, the `buildCapabilitiesManifest()` method iterates all kernel exports × transcoder edges and calls `mergeJsonSchemas(cap, edge)` for matching `cap.format === edge.from` pairs (line 2022-2023). This merges the kernel's source-format JSON Schema (e.g., GLB tessellation/coordinateSystem) with the transcoder edge schema (e.g., USDZ quality) into a single combined schema on the `ExportRoute`.

The `executeExportWithRoute()` method (line 2106-2113) validates `input.options` against both:

1. The kernel's source format Zod schema (`sourceZodSchema.safeParse(input.options)`)
2. The transcoder edge's Zod schema (`matchingEdge.optionsSchema.safeParse(input.options)`)

Both validations operate on the **same** flat options bag. This means consumers pass a single object containing all options — source format and edge options together.

### Finding 2: The Type System Has No Source-Format Knowledge on Edges

The `createTranscoderPlugin` `edges` config is keyed by **target format** only:

```typescript
edges: {
  usdz: z.object({ quality: z.number() });
}
```

This produces `TranscoderPlugin<{ usdz: { quality: number } }>`. There is no `from` field — the source format is only known at runtime when `discoverEdges()` returns `TranscoderEdge` objects with both `from` and `to`.

`CollectTranscodeMap` extracts these phantom edge maps and `MergeExportMap` combines them with kernel format maps via `&` (intersection). The result is:

```typescript
ExportMap = { glb: { tessellation: ... } } & { usdz: { quality: number } }
         = { glb: { tessellation: ... }; usdz: { quality: number } }
```

The `usdz` entry carries only the transcoder's own options, not the merged kernel source-format options.

### Finding 3: The Missing Link is `from → to` Edge Routing at the Type Level

To merge source-format options into the transcoder target type, the type system needs to know:

1. **Which source format** a transcoder edge converts from (the `from` field)
2. **Which kernel** provides that source format (linking back to `CollectFormatMap`)

This is fundamentally a **graph edge** problem at the type level: given kernel format nodes and transcoder edges between them, compute the merged options for each reachable target.

### Finding 4: The `edges` Config Must Carry Source-Format Information

Currently `edges` is `Record<targetFormat, ZodSchema>`. To enable type-level merging, the edge config must also express the source format. There are several possible shapes:

#### Option A: Nested `from` → `to` Map

```typescript
edges: {
  glb: {  // source format
    usdz: z.object({ quality: z.number() }),  // target format → options
  },
}
```

**Pros:** Explicit, mirrors `TranscoderEdge` structure, handles multi-source transcoders.
**Cons:** Deeper nesting, more verbose config for simple single-source transcoders.

#### Option B: Flat Map with Source Annotation

```typescript
edges: {
  usdz: { from: 'glb' as const, schema: z.object({ quality: z.number() }) },
}
```

**Pros:** Keeps target-keyed structure, explicit source.
**Cons:** Changes the shape from `Record<string, ZodType>` to `Record<string, { from, schema }>`, breaking existing edge declarations.

#### Option C: Separate `from` Declaration (Single Source)

```typescript
{
  from: 'glb' as const,
  edges: { usdz: z.object({ quality: z.number() }) },
}
```

**Pros:** Simple for single-source transcoders (the common case — converter always converts from GLB), minimal config change.
**Cons:** Cannot express multi-source transcoders (e.g., a hypothetical transcoder that converts from both GLB and STEP). Requires a generic parameter for the `from` literal type.

### Finding 5: Type-Level Merge Computation

Given source-format information, a new type helper can compute the merged export map. The type computation needs to:

1. For each transcoder edge `(From → To)`, look up `From` in the kernel `FormatMap`
2. Intersect the kernel format options with the transcoder edge options
3. Index the result by `To` (the target format)

Conceptual helper:

```typescript
type MergeExportMap<
  FormatMap extends Record<string, unknown>,
  EdgeMap extends Record<string, unknown>,
  EdgeSources extends Record<string, string>, // target → source format
> = FormatMap & {
  [Target in keyof EdgeMap]: Target extends string
    ? EdgeSources[Target] extends keyof FormatMap
      ? FormatMap[EdgeSources[Target]] & EdgeMap[Target] // merge source + edge
      : EdgeMap[Target] // no source match, edge-only
    : EdgeMap[Target];
};
```

This requires `EdgeSources` — a mapping from target format to source format — to be available at the type level.

### Finding 6: Impact on `createTranscoderPlugin` Factory Generics

The `createTranscoderPlugin` function currently infers `EdgeSchemas extends Record<string, z.ZodType>` and produces `TranscoderPlugin<ResolveEdgeMap<EdgeSchemas>>`. To carry source information, the factory would need to also infer or accept the `from` format and thread it through the phantom type.

The `TranscoderPlugin` phantom type would need to carry both the edge map and the source routing:

```typescript
TranscoderPlugin<
  EdgeMap extends Record<string, unknown> = {},
  EdgeSources extends Record<string, string> = {},
>
```

Or alternatively, encode the source information within the edge map values themselves:

```typescript
// Edge map value carries source format info for type-level merge
type EdgeMapEntry<From extends string, Options> = Options & { __from?: From };
```

### Finding 7: Recommended Approach — Option C with Phantom Source Map

Option C (single `from` declaration) is the most pragmatic choice because:

1. **All current transcoders have a single source format** — the converter transcoder always converts from GLB. This is architecturally inherent: transcoders typically accept one intermediate format.

2. **Minimal config change** — adding a single `from` field to the config is non-breaking for the runtime (it's stripped before creating the plugin object, like `edges` currently is).

3. **Clean generic threading** — a single `From` literal generic on `TranscoderPlugin` carries the source format info through to `MergeExportMap`.

The `TranscoderPlugin` type would gain a second phantom:

```typescript
declare const __transcodeFrom: unique symbol;

type TranscoderPlugin<EdgeMap extends Record<string, unknown> = {}, From extends string = string> = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
  readonly [__transcodeEdges]?: EdgeMap;
  readonly [__transcodeFrom]?: From;
};
```

And `MergeExportMap` would use this to compute merged types:

```typescript
type MergeExportMap<
  FormatMap extends Record<string, unknown>,
  Transcoders extends readonly TranscoderPlugin<any, any>[],
> = FormatMap & MergedTranscoderEdges<FormatMap, Transcoders>;

type MergedTranscoderEdges<
  FormatMap extends Record<string, unknown>,
  Transcoders extends readonly TranscoderPlugin<any, any>[],
> = {
  [Target in keyof CollectTranscodeMap<Transcoders>]: TranscoderSourceFor<Transcoders, Target> extends keyof FormatMap
    ? FormatMap[TranscoderSourceFor<Transcoders, Target>] & CollectTranscodeMap<Transcoders>[Target]
    : CollectTranscodeMap<Transcoders>[Target];
};
```

Where `TranscoderSourceFor` extracts the `From` phantom from the transcoder whose edge map contains `Target`.

### Finding 8: Complexity Boundary — Multi-Transcoder Source Resolution

When multiple transcoders are present, `TranscoderSourceFor` must resolve which transcoder owns which target format. If two transcoders both declare `usdz` as a target (from different sources), the type system needs to handle the ambiguity. In practice, the runtime picks the first viable route — the type system should union the possible option types.

For the common case (distinct target formats per transcoder), this is straightforward. For overlapping targets, the union approach (`FormatMap[SourceA] & EdgeMapA[Target] | FormatMap[SourceB] & EdgeMapB[Target]`) preserves soundness.

### Finding 9: `createTranscoderPlugin` Config Shape Change

The updated config:

```typescript
type TranscoderPluginConfig<
  From extends string = string,
  EdgeSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> = Omit<TranscoderPlugin<any, any>, 'options'> & {
  from?: From;
  edges?: EdgeSchemas;
};
```

For the converter transcoder:

```typescript
export const converterTranscoder = createTranscoderPlugin({
  id: 'converter',
  moduleUrl: new URL('converter.transcoder.js', import.meta.url).href,
  from: 'glb',
});
```

For test fixtures:

```typescript
const t1 = createTranscoderPlugin({
  id: 't1',
  moduleUrl: 't1.js',
  from: 'glb',
  edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
});
```

### Finding 10: Alternative — Infer Source from Kernel FormatMap Keys

An alternative to adding `from` to the transcoder config is to compute the source format at the `MergeExportMap` level by checking which kernel formats exist. If a transcoder target is not a kernel format, check all kernel format keys as potential sources.

This is unsound — the type system cannot know which kernel format a transcoder actually converts from without explicit declaration. A transcoder converting from STEP→USDZ would be mistyped if the type system guessed GLB→USDZ. The explicit `from` field is essential for correctness.

### Finding 11: Impact on Existing API Surface

| Change                                               | Scope             | Breaking?                                                       |
| ---------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| `TranscoderPlugin` gains `From` generic              | Type-level only   | No — defaults to `string`                                       |
| `__transcodeFrom` phantom symbol                     | Compile-time only | No                                                              |
| `createTranscoderPlugin` config adds optional `from` | Additive          | No                                                              |
| `MergeExportMap` signature changes                   | Type helper       | Yes — gains `Transcoders` param                                 |
| `createRuntimeClient` overload                       | Internal          | No — inferred                                                   |
| Existing `edges`-only configs                        | Still work        | No — `From` defaults to `string`, merge falls back to edge-only |
| Test fixtures need `from`                            | Tests only        | N/A                                                             |

### Finding 12: Interaction with `CollectTranscodeMap`

`CollectTranscodeMap` currently produces a flat `Record<target, options>` with no source info. It would remain unchanged — it still collects edge maps. The source-format merge is a new concern handled by `MergeExportMap`, which would need to accept the raw transcoder tuple (not just the flattened edge map) so it can access per-transcoder `From` phantoms.

This means `MergeExportMap` changes from:

```typescript
type MergeExportMap<FormatMap, EdgeMap> = FormatMap & EdgeMap;
```

To:

```typescript
type MergeExportMap<
  FormatMap extends Record<string, unknown>,
  Transcoders extends readonly TranscoderPlugin<any, any>[],
> = FormatMap & MergedTranscoderEdges<FormatMap, Transcoders>;
```

And `createRuntimeClient` changes from:

```typescript
RuntimeClient<
  MergeExportMap<CollectFormatMap<Kernels>, CollectTranscodeMap<Transcoders>>,
  CollectRenderOptions<Kernels>
>;
```

To:

```typescript
RuntimeClient<MergeExportMap<CollectFormatMap<Kernels>, Transcoders>, CollectRenderOptions<Kernels>>;
```

### Finding 13: Full Type-Level Merge Computation

The complete set of type helpers:

```typescript
// Extract the From phantom from a TranscoderPlugin
type ExtractFrom<T extends TranscoderPlugin<any, any>> = T extends TranscoderPlugin<any, infer F> ? F : string;

// Extract the EdgeMap phantom from a TranscoderPlugin
type ExtractEdgeMap<T extends TranscoderPlugin<any, any>> = T extends TranscoderPlugin<infer E, any> ? E : {};

// For a single transcoder, compute merged target options
type MergedEdgesForTranscoder<FormatMap extends Record<string, unknown>, T extends TranscoderPlugin<any, any>> = {
  [Target in keyof ExtractEdgeMap<T>]: ExtractFrom<T> extends keyof FormatMap
    ? FormatMap[ExtractFrom<T>] & ExtractEdgeMap<T>[Target]
    : ExtractEdgeMap<T>[Target];
};

// Union-merge across all transcoders in a tuple
type MergedTranscoderEdges<
  FormatMap extends Record<string, unknown>,
  Transcoders extends readonly TranscoderPlugin<any, any>[],
> = UnionToIntersection<
  Transcoders[number] extends infer T extends TranscoderPlugin<any, any>
    ? MergedEdgesForTranscoder<FormatMap, T>
    : never
>;

// Final merge: kernel formats + source-aware transcoder edges
type MergeExportMap<
  FormatMap extends Record<string, unknown>,
  Transcoders extends readonly TranscoderPlugin<any, any>[],
> = FormatMap & MergedTranscoderEdges<FormatMap, Transcoders>;
```

## Recommendations

| #   | Action                                                                                    | Priority | Effort | Impact                                                                    |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------- |
| R1  | Add `From` phantom type to `TranscoderPlugin` via `__transcodeFrom` symbol                | P0       | Low    | Enables source-format awareness at compile time                           |
| R2  | Add optional `from` field to `TranscoderPluginConfig` in `createTranscoderPlugin`         | P0       | Low    | Provides the source-format declaration site                               |
| R3  | Refactor `MergeExportMap` to accept `Transcoders` tuple and compute source-aware merges   | P0       | Medium | Core fix — transcoded format options include kernel source-format options |
| R4  | Update `createRuntimeClient` overload to thread `Transcoders` tuple into `MergeExportMap` | P0       | Low    | Plumbs the new type through to the client                                 |
| R5  | Add `from: 'glb'` to converter transcoder plugin config                                   | P0       | Low    | Types real converter transcoder correctly                                 |
| R6  | Update existing test fixtures to include `from` field                                     | P0       | Low    | Test coverage for new behavior                                            |
| R7  | Add type tests for source-format merging (the failing test + edge cases)                  | P0       | Medium | Validates the fix and documents expected behavior                         |
| R8  | Update `CollectTranscodeMap` JSDoc to clarify it returns edge-only options (not merged)   | P1       | Low    | Documentation clarity                                                     |

## Code Examples

### Before (current — broken types)

```typescript
const t1 = createTranscoderPlugin({
  id: 't1',
  moduleUrl: 't1.js',
  edges: { usdz: z.object({ quality: z.number() }) },
});

// ExportMap['usdz'] = { quality: number }
// Missing: tessellation, coordinateSystem from GLB kernel
```

### After (proposed — correct types)

```typescript
const t1 = createTranscoderPlugin({
  id: 't1',
  moduleUrl: 't1.js',
  from: 'glb',
  edges: { usdz: z.object({ quality: z.number() }) },
});

// ExportMap['usdz'] = { quality: number } & { tessellation: ...; coordinateSystem: ... }
// = { quality: number; tessellation: ...; coordinateSystem: ... }
```

### Type-Level Merge (conceptual)

```typescript
// Given:
// FormatMap = { glb: { tessellation: T; coordinateSystem: C } }
// Transcoders = [TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>]

// MergeExportMap computes:
// { glb: { tessellation: T; coordinateSystem: C } }  (kernel-native, unchanged)
// & { usdz: FormatMap['glb'] & { quality: number } } (merged: source + edge)
// = { glb: ...; usdz: { tessellation: T; coordinateSystem: C; quality: number } }
```

## Diagrams

### Current Type Flow (broken)

```
KernelPlugin ──exportSchemas──▶ FormatMap ─────────────────────────────┐
                                 { glb: { tess, coordSys } }          │
                                                                       ▼
                                                              MergeExportMap = FormatMap & EdgeMap
                                                              { glb: ..., usdz: { quality } }
TranscoderPlugin ──edges──▶ EdgeMap ──────────────────────────────────┘
                             { usdz: { quality } }
                             (no source-format info)
```

### Proposed Type Flow (fixed)

```
KernelPlugin ──exportSchemas──▶ FormatMap ─────────────────────────────┐
                                 { glb: { tess, coordSys } }          │
                                                                       ▼
                                                              MergeExportMap(FormatMap, Transcoders)
                                                              { glb: ...,
                                                                usdz: FormatMap['glb'] & { quality }
                                                                     = { tess, coordSys, quality } }
TranscoderPlugin ──from──▶ 'glb' (phantom)                            │
                 ──edges──▶ EdgeMap ───────────────────────────────────┘
                             { usdz: { quality } }
```

## References

- `packages/runtime/src/plugins/plugin-types.ts` — `TranscoderPlugin`, `CollectTranscodeMap`, `MergeExportMap`
- `packages/runtime/src/plugins/plugin-helpers.ts` — `createTranscoderPlugin` factory
- `packages/runtime/src/client/runtime-client.ts` — `createRuntimeClient` overloads, `RuntimeClient.export()`
- `packages/runtime/src/framework/kernel-worker.ts` — `buildCapabilitiesManifest()`, `executeExportWithRoute()`, `mergeJsonSchemas()`
- `packages/runtime/src/types/define-plugin.test-d.ts` — Failing test at line 2297-2303
- Related: `docs/research/runtime-client-type-safety-audit.md`
