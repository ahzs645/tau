---
title: 'defineTranscoder Type Safety Overhaul'
description: 'Audit of loose typing in the defineTranscoder API and recommendations for schema-driven type safety matching the defineKernel pattern'
status: active
created: '2026-04-10'
updated: '2026-04-10'
category: audit
related:
  - docs/policy/library-api-policy.md
  - docs/research/export-pipeline-v5.md
---

# defineTranscoder Type Safety Overhaul

Audit of the `defineTranscoder` API surface to identify loose typing, redundant methods, and type erasure points, with recommendations for a schema-driven overhaul following the `defineKernel` pattern.

## Executive Summary

The current `defineTranscoder` API has five type safety gaps that force consumers to use `as` casts and prevent TypeScript from narrowing `input.to`/`input.from` in the `transcode` method. The root causes are: (1) `discoverEdges` is an async function when it should be a static `edges` property, (2) `canTranscode` is redundant — the framework already filters routes via manifest edges, (3) `TranscoderEdge.from`/`to` use the wide `FileExtension` union instead of literal types, (4) `TranscodeInput.from`/`to` are unlinked to the edges, and (5) per-edge `optionsSchema` types don't flow into the `transcode` method input. The fix follows the `defineKernel` pattern: declare schemas statically, infer all types from them, and let the framework handle routing.

## Problem Statement

The converter transcoder at `packages/runtime/src/transcoders/converter/converter.transcoder.ts` requires three explicit `as` casts:

| Line | Cast                                            | Why required                                               |
| ---- | ----------------------------------------------- | ---------------------------------------------------------- |
| 28   | `format as keyof typeof converterExportOptions` | `format` is `SupportedExportFormat`, not narrowed by edges |
| 42   | `input.to as SupportedExportFormat`             | `TranscodeInput.to` is `FileExtension` (200+ formats)      |
| 64   | `input.to as SupportedExportFormat`             | Same — `transcode` receives the wide type                  |

In `defineKernel`, the analogous scenario is `exportGeometry`, where `input.format` narrows to specific literal strings (e.g., `'glb' | 'gltf'`) and `input.options` narrows to the corresponding Zod-inferred type — all without any casts. This is achieved via the `ExportSchemas` generic that flows through `ExportGeometryInput`.

## Methodology

1. Read the `defineTranscoder` type definition (`runtime-transcoder.types.ts`)
2. Read the sole consumer — the converter transcoder (`converter.transcoder.ts`)
3. Read the framework consumer — `kernel-worker.ts` transcoder loading, `buildCapabilitiesManifest`, and `executeExportWithRoute`
4. Read the `defineKernel` pattern (`runtime-kernel.types.ts`) and a concrete kernel (`openscad.kernel.ts`) for comparison
5. Read `library-api-policy.md` for API design constraints
6. Compared type flow at each boundary

## Findings

### Finding 1: `discoverEdges` is needlessly dynamic

`discoverEdges` is declared as `async (runtime, context) => Promise<TranscoderEdge[]>`. The converter transcoder implementation never uses `runtime` or `context` — it filters a static `supportedExportFormats` array that is known at module evaluation time. Every framework consumer calls `discoverEdges` exactly once during initialization and caches the result in `LoadedTranscoder.edges`.

The `defineKernel` analogy is `exportSchemas`, which is a **static property** on the definition object, not a method. Edges should follow the same pattern.

**Impact**: The async function signature prevents TypeScript from inferring literal types from the edge declarations. A static `edges` property with `as const` enables full literal inference.

### Finding 2: `canTranscode` is redundant

The framework's `executeExportWithRoute` already filters candidate routes by matching `route.sourceFormat` and `route.targetFormat` against the capabilities manifest. The `canTranscode` call at line 2091 of `kernel-worker.ts` is a second filter on the same data:

```typescript
const canProceed = await transcoder.definition.canTranscode(
  { from: route.sourceFormat, to: input.format, files: [] },
  transcoderRuntime,
  transcoder.context,
);
```

The converter transcoder's `canTranscode` implementation checks `input.from === 'glb' && input.to !== 'glb' && supportedExportFormats.includes(...)` — exactly the same constraint already encoded in its `discoverEdges` return value. The `files: []` argument confirms the framework doesn't even have the actual files at guard-check time.

The `defineKernel` API has no equivalent — `exportGeometry` is called directly for matching formats. The kernel worker's route planner handles all routing decisions.

**Impact**: Removing `canTranscode` eliminates a redundant async call per export attempt, removes a loose-typed `TranscodeInput` construction site, and simplifies the definition contract.

### Finding 3: `TranscoderEdge.from`/`to` use the wide `FileExtension` union

`TranscoderEdge` types `from` and `to` as `FileExtension`, which is a union of 200+ string literals. When a transcoder declares `{ from: 'glb', to: 'usdz' }`, the literal types `'glb'` and `'usdz'` are immediately widened to `FileExtension`.

In contrast, `defineKernel`'s `exportSchemas` uses `Record<string, z.ZodType>`, where TypeScript infers the _keys_ as literal strings (e.g., `{ glb: ..., gltf: ... }` produces `'glb' | 'gltf'`). This is the mechanism that enables the discriminated union in `ExportGeometryInput`.

**Impact**: Without literal types flowing from edge declarations, `TranscodeInput.from`/`to` cannot be narrowed, forcing `as` casts everywhere.

### Finding 4: `TranscodeInput` types are unlinked from edge declarations

`TranscodeInput` uses `{ from: FileExtension; to: FileExtension }` unconditionally. There is no generic parameter connecting the edge declaration to the input types. Compare with `ExportGeometryInput<NativeHandle, ExportSchemas>`, which uses `ExportSchemas` to create a discriminated union where narrowing `input.format` automatically narrows `input.options`.

The ideal `TranscodeInput` should be derived from the transcoder's declared edges, such that:

- `input.from` is constrained to the literal `from` values declared in edges
- `input.to` is constrained to the literal `to` values declared in edges
- `input.options` is narrowed based on the edge's `optionsSchema`

### Finding 5: Per-edge `optionsSchema` types don't flow to `transcode`

`TranscoderEdge.optionsSchema` is typed as `z.ZodType` — a wide type that erases the inferred options structure. The framework does validate options against this schema at runtime (line 2126 of `kernel-worker.ts`), but the `transcode` method receives `options?: Record<string, unknown>` regardless of what schema was declared.

In `defineKernel`, the `ExportSchemas` generic is a `Record<string, z.ZodType>` where each key's value is a concrete Zod schema. This enables the discriminated union in `ExportGeometryInput` to produce `z.infer<ExportSchemas[K]>` for each format key `K`.

**Impact**: Transcoder authors must manually re-parse or cast options inside `transcode`, duplicating the schema validation the framework already performs.

### Finding 6: Converter transcoder re-imports external format types

The converter transcoder imports `SupportedExportFormat` from `@taucad/converter/formats` and uses it for `as` casts. If the edge declarations carried the literal types, no external type import would be needed — the transcoder's own `edges` property would be the single source of truth.

### Finding 8: Plugin-side `edges` parity gap (post-R6 regression)

After R6 landed, the runtime `defineTranscoder` `edges` tuple in `converter.transcoder.ts` correctly declares all 13 GLB→<format> edges plus the `'3mf'` `optionsSchema`, and `kernel-worker.mergeJsonSchemas` correctly merges per-edge schemas with kernel source-format schemas at runtime — visible in the export dialog where `'3mf'` shows `unit` and `application` next to `tessellation` and `coordinateSystem`.

However, the matching plugin-side declaration in `converter.plugin.ts` did **not** pass any `edges` to `createTranscoderPlugin`:

```typescript
export const converterTranscoder = createTranscoderPlugin({
  id: 'converter',
  moduleUrl: new URL('converter.transcoder.js', import.meta.url).href,
  from: 'glb',
});
```

Because `createTranscoderPlugin` infers the `EdgeMap` phantom only from the `edges` argument, the omission collapsed `EdgeMap` to `{}`, and `MergeExportMap<KernelFormatMap, [TranscoderPlugin<{}, 'glb'>]>` lost every transcoded target. `client.export('3mf' | 'fbx' | …, …)` silently fell through to the wide `(format: FileExtension, input: FileInput)` overload, accepting any input shape at compile time — even though the runtime would still validate the merged schema.

**Smoking gun**: two parallel sources of truth (`converterEdgeSchemas` for compile-time, `edges` tuple for runtime) without any structural cross-check. R9 (single source of truth in `converter-export-options.ts`) and R10 (consumer-side `test-d.ts` against the production factory) close this gap.

### Finding 9: Preset-path kernel-aggregation collapses merged options (deferred)

`presets.all()` aggregates kernels whose `glb` schema is `z.object({})` (`manifold`, `zoo`, `tau`, `jscad`). Zod 4 resolves `z.object({})` to `Record<string, never>`, and `CollectFormatMap` intersects per-format option types via `UnionToIntersection`. `Record<string, never> & { tessellation: … }` collapses `tessellation` to `never`, annihilating both kernel-native (`client.export('glb', …)`) and merged transcoded (`client.export('3mf', …)`) typing on the preset path.

This is independent of the converter wiring: it affects every aggregated multi-kernel client. Single-kernel clients (`createRuntimeClient({ kernels: [replicad()], … })`) are unaffected.

The fix requires changing kernel-side `glb: z.object({})` declarations to a non-annihilating placeholder (e.g. `z.unknown()`, mirroring the `noEdgeOptions` pattern introduced for converter edges in R9). That is out of scope for the converter transcoder type-safety overhaul and is tracked here as R11 for follow-up.

### Finding 7: `converterExportOptions` pattern is good but disconnected

The `converter-export-options.ts` file declares per-format Zod schemas with a `schema` + `toAssimpProperties` pattern. This is a well-structured dual-schema approach (consumer-facing schema and internal property mapping). However, it is not connected to the `defineTranscoder` type system — the transcoder manually threads `converterExportOptions[formatKey].schema` into edge `optionsSchema` and separately uses `converterExportOptions[formatKey].toAssimpProperties` inside `transcode`.

A schema-driven `defineTranscoder` should make this connection declarative.

## Recommendations

| #   | Action                                                                           | Priority | Effort | Impact | Status   |
| --- | -------------------------------------------------------------------------------- | -------- | ------ | ------ | -------- |
| R1  | Replace `discoverEdges()` with static `edges` property                           | P0       | Low    | High   | RESOLVED |
| R2  | Remove `canTranscode` from the definition contract                               | P0       | Low    | Medium | RESOLVED |
| R3  | Add `Edges` generic parameter to `TranscoderDefinition`                          | P0       | Medium | High   | RESOLVED |
| R4  | Derive `TranscodeInput` `from`/`to`/`options` from `Edges`                       | P0       | Medium | High   | RESOLVED |
| R5  | Type `TranscoderEdge.optionsSchema` with concrete Zod generics                   | P1       | Medium | Medium | RESOLVED |
| R6  | Update converter transcoder to use the new API                                   | P1       | Low    | Medium | RESOLVED |
| R7  | Add `define-plugin.test-d.ts` type-level tests for `defineTranscoder`            | P1       | Low    | High   | RESOLVED |
| R8  | Update framework `kernel-worker.ts` to consume static `edges`                    | P1       | Low    | Low    | RESOLVED |
| R9  | Single source of truth for converter edge schemas + plugin wiring                | P0       | Low    | High   | RESOLVED |
| R10 | Consumer-side `test-d.ts` against the production `converterTranscoder()` factory | P0       | Low    | High   | RESOLVED |
| R11 | Fix preset-path kernel-aggregation collapse for `glb: z.object({})`              | P1       | Medium | Medium | OPEN     |

### R1: Static `edges` property

**Status**: RESOLVED — `TranscoderDefinition.edges: Edges` now replaces `discoverEdges()`; the framework reads it directly via `definition.edges`.

Replace the `discoverEdges` method with a static `edges` property. This is the enabler for all downstream type inference.

**Before:**

```typescript
export type TranscoderDefinition<Context, Options> = {
  discoverEdges(runtime: TranscoderRuntime, context: Context): Promise<TranscoderEdge[]>;
  // ...
};
```

**After:**

```typescript
export type TranscoderDefinition<Context, Options, Edges extends readonly TranscoderEdge[]> = {
  edges: Edges;
  // ...
};
```

The `defineTranscoder` function infers `Edges` from the literal value:

```typescript
export default defineTranscoder({
  edges: [
    { from: 'glb', to: 'usdz', fidelity: 'mesh' },
    { from: 'glb', to: '3mf', fidelity: 'mesh', optionsSchema: threeMfSchema },
  ] as const,
  // ...
});
```

### R2: Remove `canTranscode`

**Status**: RESOLVED — `canTranscode` is removed from `TranscoderDefinition`; `kernel-worker.executeExportWithRoute` no longer issues a guard check before invoking `transcode`.

The framework already uses the manifest's `exportRoutes` for route planning. The `canTranscode` runtime guard is a second filter on the same data and has never returned `false` in production — only in a single test that explicitly mocks it.

After removal, the framework's `executeExportWithRoute` loop simply removes the `canTranscode` check and proceeds directly to `transcode`. If a transcoder needs to reject at runtime (e.g., license check), it can return `{ success: false }` from `transcode`.

### R3–R5: Generic `Edges` → derived `TranscodeInput`

**Status**: RESOLVED — `TranscoderEdge<From, To, Schema>` and `TranscoderDefinition<Context, Options, Edges>` are now generic; `TranscodeInput<Edges>` is a discriminated union, narrowing `input.from`, `input.to`, and `input.options` per declared edge.

The approach mirrors `defineKernel`'s `ExportSchemas` → `ExportGeometryInput` pattern:

1. `Edges` generic captures the literal edge types
2. Extract `From = Edges[number]['from']` and `To = Edges[number]['to']` as literal unions
3. Create a discriminated union on `to` for `TranscodeInput`, where each branch carries the corresponding `optionsSchema`'s inferred type

This eliminates all `as` casts in the converter transcoder.

### R7: Type-level tests

**Status**: RESOLVED — comprehensive `defineTranscoder type inference` and `TranscodeInput discriminated union` describe blocks added to `packages/runtime/src/types/define-plugin.test-d.ts`, asserting (a) literal `from`/`to` narrowing, (b) per-edge options narrowing on discriminated `to`, (c) absence of `discoverEdges`/`canTranscode`, and (d) inference without explicit type arguments.

Add tests to `define-plugin.test-d.ts` (or a new `define-transcoder.test-d.ts`) verifying:

- `edges` literal types flow through to `transcode` `input.from`/`input.to`
- `optionsSchema` Zod types narrow `input.options` per-edge
- `defineTranscoder` infers all generics without explicit type arguments
- `canTranscode` is absent from the contract

### R9: Single source of truth for converter edge schemas + plugin wiring

**Status**: RESOLVED — `converterEdgeSchemas` is now exported from `packages/runtime/src/transcoders/converter/converter-export-options.ts` and consumed by both:

- `packages/runtime/src/transcoders/converter/converter.plugin.ts` — passed as the `edges` argument to `createTranscoderPlugin`, which makes the `EdgeMap` phantom flow into `MergeExportMap` and `RuntimeClient.export()`.
- `packages/runtime/src/transcoders/converter/converter.transcoder.ts` — the runtime `defineTranscoder` `edges` tuple `optionsSchema` field references `converterExportOptions['3mf'].schema`, which is the same Zod instance held by `converterEdgeSchemas['3mf']`.

Schemaless targets share a single `noEdgeOptions = z.unknown()` placeholder. `unknown` was chosen over `z.object({})` because Zod 4 resolves the latter to `Record<string, never>`, which would collapse the merged `KernelGlbOptions & EdgeOptions` intersection to `never`. With `unknown`, the intersection simplifies to just the kernel source-format options — exactly what we want for transcoded targets that only inherit GLB options.

A drift-guard test in `converter.transcoder.test.ts` asserts (a) every key in `converterEdgeSchemas` has a matching runtime edge `to`, (b) every runtime edge `to` is a key in `converterEdgeSchemas`, and (c) the `'3mf'` Zod instance is shared across `converterExportOptions`, `converterEdgeSchemas`, and the runtime edge `optionsSchema`.

### R10: Consumer-side `test-d.ts` against the production factory

**Status**: RESOLVED — a new `describe('converterTranscoder + replicad — production factories')` block in `packages/runtime/src/types/define-plugin.test-d.ts` exercises the real `converterTranscoder()` and `replicad()` factories through `createRuntimeClient` and asserts:

- `client.export('3mf', { unit, application, tessellation, coordinateSystem })` typechecks (merged source + edge options).
- `client.export('3mf', {})` typechecks (all-optional defaulted shape).
- `client.export('3mf', { unit: 'parsec' })`, `{ application: 42 }`, and `{ tessellation: 'invalid' }` are `@ts-expect-error`.
- `client.export('fbx', { tessellation: { linearTolerance: 0.1 } })` typechecks (schemaless edge inherits GLB options via `MergeExportMap`).
- `client.export('fbx', { quality: 0.5 })` is `@ts-expect-error` (excess property — fbx has no edge-specific options).
- `client.export('glb', { tessellation: { linearTolerance: 0.1 } })` continues to typecheck (kernel-native, untouched by the transcoder).

These tests would have caught Finding 8 immediately and now lock the contract going forward.

### R11: Preset-path kernel-aggregation collapse (deferred)

**Status**: OPEN — see Finding 9. Rolling out R11 requires changing `glb: z.object({})` (and similar schemaless declarations) in `manifold.schemas.ts`, `zoo.schemas.ts`, `tau.schemas.ts`, and `jscad.schemas.ts` to a non-annihilating placeholder. The natural choice mirrors `noEdgeOptions` from R9 (`z.unknown()`), but doing so changes runtime semantics for `client.export('glb', …)` on those kernels (today: empty-object accepted; after: any value accepted at the type level, with runtime validation governed by the actual kernel implementation). A focused follow-up audit should pick the right placeholder per-kernel (some may want `z.object({}).loose()`, others `z.unknown()`) and verify there are no consumer-visible behavior changes.

The `presets.all()` describe block in `define-plugin.test-d.ts` documents this constraint inline so future readers don't reintroduce broken assertions before R11 lands.

## Diagrams

### Current type flow (broken)

```
defineTranscoder({
  discoverEdges() → TranscoderEdge[]        ← from/to: FileExtension (wide)
  canTranscode(input: TranscodeInput) → bool ← from/to: FileExtension (wide)
  transcode(input: TranscodeInput) → Result  ← from/to: FileExtension (wide), options: Record<string, unknown>
})
```

Every boundary uses the same wide types. No inference, no narrowing.

### Target type flow (schema-driven)

```
defineTranscoder({
  edges: [{ from: 'glb', to: 'usdz', fidelity: 'mesh' }, ...] as const
         ↓ inferred as Edges
  transcode(input: TranscodeInput<Edges>) → Result
         ↓ input.from: 'glb'  (literal from Edges[number]['from'])
         ↓ input.to: 'usdz' | '3mf' | ...  (literal from Edges[number]['to'])
         ↓ input.options: z.infer<matching edge's optionsSchema>
})
```

Types flow from the single `edges` declaration through every method.

## Code Examples

### Converter transcoder after overhaul (target DX)

```typescript
import { defineTranscoder } from '@taucad/runtime';
import { exportFromGlb } from '@taucad/converter';
import { converterExportOptions } from './converter-export-options.js';

export default defineTranscoder({
  name: 'ConverterTranscoder',
  version: '1.0.0',

  edges: [
    { from: 'glb', to: '3mf', fidelity: 'mesh', optionsSchema: converterExportOptions['3mf'].schema },
    { from: 'glb', to: '3ds', fidelity: 'mesh' },
    { from: 'glb', to: 'dae', fidelity: 'mesh' },
    { from: 'glb', to: 'fbx', fidelity: 'mesh' },
    { from: 'glb', to: 'obj', fidelity: 'mesh' },
    { from: 'glb', to: 'ply', fidelity: 'mesh' },
    { from: 'glb', to: 'stl', fidelity: 'mesh' },
    { from: 'glb', to: 'step', fidelity: 'mesh' },
    { from: 'glb', to: 'usda', fidelity: 'mesh' },
    { from: 'glb', to: 'usdz', fidelity: 'mesh' },
    { from: 'glb', to: 'x', fidelity: 'mesh' },
    { from: 'glb', to: 'x3d', fidelity: 'mesh' },
  ] as const,

  async initialize() {
    return {};
  },

  async transcode(input, runtime) {
    // input.from is 'glb' (literal)
    // input.to is '3mf' | '3ds' | 'dae' | ... (literal union)
    // input.options is narrowed per-edge when optionsSchema is declared
    const files = await exportFromGlb(input.files[0]!.bytes, input.to /* no cast needed */);
    return { success: true, data: files, issues: [] };
  },

  async cleanup() {},
});
```

Zero `as` casts. Full autocomplete on `input.to`. Options narrowed by schema.

## References

- `packages/runtime/src/types/runtime-transcoder.types.ts` — current `defineTranscoder` API
- `packages/runtime/src/types/runtime-kernel.types.ts` — `defineKernel` reference pattern
- `packages/runtime/src/transcoders/converter/converter.transcoder.ts` — sole consumer
- `packages/runtime/src/framework/kernel-worker.ts` — framework consumer (lines 1880–2150)
- `packages/runtime/src/transcoders/converter/converter-export-options.ts` — `converterEdgeSchemas` single source of truth (R9)
- `packages/runtime/src/transcoders/converter/converter.plugin.ts` — `createTranscoderPlugin({ edges })` wiring (R9)
- `packages/runtime/src/transcoders/converter/converter.transcoder.test.ts` — drift-guard test (R9)
- `packages/runtime/src/types/define-plugin.test-d.ts` — production-factory consumer tests (R10) and `presets.all()` deferred-coverage notice (R11)
- `docs/policy/library-api-policy.md` — API design constraints
