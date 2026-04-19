---
title: 'CollectFormatMap Aggregation Collapse Under presets.all()'
description: 'Root cause investigation of client.export type collapse when multiple kernels declare the same format with empty option schemas, and the type-level filter that fixes it without requiring kernel-author churn'
status: active
created: '2026-04-10'
updated: '2026-04-10'
category: investigation
related:
  - docs/research/define-transcoder-type-safety.md
  - docs/research/export-pipeline-v5.md
---

# CollectFormatMap Aggregation Collapse Under presets.all()

Investigation of the compile-time type collapse that breaks `client.export` typing when `createRuntimeClient` is configured with `presets.all()` (or any multi-kernel setup that declares the same format with at least one schemaless kernel).

## Executive Summary

`CollectFormatMap` aggregates per-format export option types across kernels by **intersection** (`UnionToIntersection<...>`), while the parallel `CollectRenderOptions` aggregates by **distributive union**. Five built-in kernels (`opencascade`, `manifold`, `zoo`, `tau`, `jscad`) declare schemaless formats as `z.object({})`, which Zod 4 infers as `Record<string, never>`. Under intersection algebra, `Record<string, never> & T` collapses every concrete property of `T` to `never`. The result: under `presets.all()`, every kernel-native format except `stl` becomes uncallable with literal options, and every transcoded target inherits the same collapse via `MergedEdgesForTranscoder`. Runtime is unaffected — `mergeJsonSchemas` is keyed per `(kernelId, sourceFormat)` and never aggregates across kernels.

**Recommended fix**: a type-level filter (`FilterEmpty<T>`) inside `CollectFormatMap` that detects the `Record<string, never>` annihilator via `string extends keyof T && [T[string]] extends [never]` and replaces it with `never`. Combined with a per-plugin `ContributorFor<P, K>` helper that exposes `Plugins[number]` to a naked type parameter (so the conditional distributes), the union of contributions absorbs `never` (`T | never ≡ T`) and the surviving union is intersected via `UnionToIntersection<...>`. When every contributor is the placeholder, the union collapses to `never` and `UnionToIntersection<never>` falls back to `unknown` — the natural "no constraints declared" result. This preserves the existing intersection contract (`Finding 2`), keeps `z.object({})` as the natural placeholder for kernel authors (better DX — they can incrementally extend the literal as new options arrive), and requires no schema churn across kernels. The same idiom is applied to `CollectRenderOptions` to fix the parallel `R11.b` swallowing bug.

**Implementation note (Finding 12 — discovered during R12)**: the original Approach C sketch used `unknown` as the filter result on the assumption that `T & unknown ≡ T` would let the identity element disappear inside the intersection. That works in a head/tail tuple-fold but **fails** for the `(KernelA | KernelB | …)[]` general-array shape returned by `presets.all()`, because the TypeScript checker eagerly simplifies `T | unknown ≡ unknown` _before_ `UnionToIntersection<…>` ever runs. Switching the filter to `never` and routing per-plugin extraction through a naked-type-parameter helper (`ContributorFor<P, K>`) restores correct behavior uniformly for tuples and general arrays — the form actually used by `presets.all()`.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Trade-offs — Candidate Fixes](#trade-offs--candidate-fixes)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Scope and Non-Goals](#scope-and-non-goals)
- [References](#references)

## Problem Statement

The `defineTranscoder` overhaul (`docs/research/define-transcoder-type-safety.md`, R9 + R10) closed the type-safety gap for the converter transcoder when paired with a single OCCT-backed kernel (replicad alone). After landing the fix, the `presets.all() — transcoded export type safety` block in `define-plugin.test-d.ts` continued to fail with:

```
Type '{ tessellation: { linearTolerance: 0.01 }; coordinateSystem: 'y-up'; unit: 'centimeter' }'
  is not assignable to type 'Record<string, never>'
```

The block was deferred (R11 OPEN) without root-cause analysis. This document closes that gap.

## Methodology

1. Mapped the type pipeline from `KernelPlugin` phantoms through `CollectFormatMap`, `MergedEdgesForTranscoder`, and `MergeExportMap` into the `RuntimeClient<ExportMap>.export` overload.
2. Inventoried every `*ExportSchemas` literal in `packages/runtime/src/kernels/*` to identify which kernels use the annihilating placeholder.
3. Inspected `mergeJsonSchemas` and `deriveJsonSchema` in `kernel-worker.ts` to confirm the runtime aggregation contract.
4. Audited every `client.export(...)` call site in the workspace to determine whether any consumer relies on the strict intersection semantics.
5. Modelled three candidate fixes (algebra change, placeholder swap, type-level filter) and evaluated their impact on tests, JSON Schema output, UI form rendering, and runtime behavior.

## Findings

### Finding 1: Algebra is asymmetric across the type pipeline

`packages/runtime/src/plugins/plugin-types.ts` defines two parallel collectors with different algebras:

| Collector              | Algebra                              | Caller semantics                                          |
| ---------------------- | ------------------------------------ | --------------------------------------------------------- |
| `CollectFormatMap`     | `UnionToIntersection` per format key | `options` must satisfy **every** kernel that declares `K` |
| `CollectRenderOptions` | Distributive union over plugins      | `renderOptions` must satisfy **at least one** kernel      |

There is no documented justification for the asymmetry. Both APIs face the same compile-time uncertainty about which kernel the route planner picks at runtime, and the runtime contract is identical (one kernel handles the call). Render options chose the more permissive algebra; format options chose the stricter one — likely without explicit deliberation about multi-kernel preset aggregation.

### Finding 2: The intersection assertion is encoded as intentional contract

```typescript
// packages/runtime/src/types/define-plugin.test-d.ts:1306-1312
it('should intersect overlapping format options from multiple plugins', () => {
  type PluginA = KernelPlugin<{ stl: { binary: boolean } }>;
  type PluginB = KernelPlugin<{ stl: { quality: number } }>;

  type Merged = CollectFormatMap<[PluginA, PluginB]>;
  expectTypeOf<Merged>().toEqualTypeOf<{ stl: { binary: boolean } & { quality: number } }>();
});
```

Switching algebras is a deliberate contract break. The test must be rewritten and the public JSDoc on `CollectFormatMap` updated.

### Finding 3: Five kernels declare schemaless formats with the annihilating placeholder

Inventory of every `*ExportSchemas` literal in `packages/runtime/src/kernels/*`:

| Kernel        | stl                    | step               | glb                   | gltf                   |
| ------------- | ---------------------- | ------------------ | --------------------- | ---------------------- |
| `replicad`    | `occtStlExportSchema`  | `coordinateSystem` | `occtGlbExportSchema` | `occtGltfExportSchema` |
| `opencascade` | `occtStlExportSchema`  | **`z.object({})`** | `occtGlbExportSchema` | `occtGltfExportSchema` |
| `openscad`    | —                      | —                  | `tessellation+coord`  | `tessellation+coord`   |
| `zoo`         | `{ binary?: boolean }` | **`z.object({})`** | **`z.object({})`**    | **`z.object({})`**     |
| `manifold`    | —                      | —                  | **`z.object({})`**    | —                      |
| `tau`         | —                      | —                  | **`z.object({})`**    | **`z.object({})`**     |
| `jscad`       | —                      | —                  | **`z.object({})`**    | —                      |

`z.input<z.object({})>` resolves to `Record<string, never>` in Zod 4. Under intersection algebra, **every kernel-native format other than `stl` collapses for `presets.all()`**:

| Format | Annihilating members                       | Result                                               |
| ------ | ------------------------------------------ | ---------------------------------------------------- |
| `glb`  | manifold, zoo, tau, jscad                  | `Record<string, never>` — fields collapse to `never` |
| `gltf` | zoo, tau                                   | `Record<string, never>`                              |
| `step` | opencascade, zoo                           | `Record<string, never>`                              |
| `stl`  | none (zoo declares `{ binary?: boolean }`) | Survives as `OcctStl & { binary?: boolean }`         |

### Finding 4: Transcoded formats inherit the collapse via `MergedEdgesForTranscoder`

```typescript
// packages/runtime/src/plugins/plugin-types.ts:206-214
type MergedEdgesForTranscoder<FormatMap, T> = {
  [Target in keyof ExtractEdgeMap<T>]: ExtractFrom<T> extends keyof FormatMap
    ? FormatMap[ExtractFrom<T>] & ExtractEdgeMap<T>[Target]
    : ExtractEdgeMap<T>[Target];
};
```

`FormatMap['glb']` already collapsed to `Record<string, never>` for `presets.all()`, so for every converter target (`3mf`, `fbx`, `usdz`, `usda`, `obj`, `dae`, `ply`, `stl`, `step`, `3ds`, `gltf`, `x`, `x3d`) we get `Record<string, never> & EdgeOptions = never` for the OCCT-side fields. This is the exact failure observed at the end of the `defineTranscoder` overhaul.

### Finding 5: Runtime is not affected

```typescript
// packages/runtime/src/framework/kernel-worker.ts:2716-2747
function mergeJsonSchemas(a, b) {
  const aEmpty = Object.keys(a.schema).length === 0;
  const bEmpty = Object.keys(b.schema).length === 0;
  if (aEmpty && bEmpty) return { schema: {}, defaults: {} };
  if (bEmpty) return { schema: a.schema, defaults: a.defaults };
  if (aEmpty) return { schema: b.schema, defaults: b.defaults };
  // ... merge properties + required
}
```

The runtime merge runs **per route** (one kernel × one source format × one transcoder edge). It never aggregates across kernels. Real call sites in the workspace either supply `event.options` / `formatOptions[format] ?? {}` (untyped) or call without options at all:

| Caller                                                | Pattern                                              |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `apps/ui/app/machines/cad.machine.ts`                 | `client.export(event.format, event.options)`         |
| `apps/ui/app/routes/projects_.$id/chat-converter.tsx` | `client.export(format, formatOptions[format] ?? {})` |
| `apps/ui/app/hooks/use-ar.ts`                         | `client.export('usdz')` (no options)                 |
| `packages/cli/src/commands/export.ts`                 | dynamic, untyped `options` from CLI args             |

No real consumer benefits from the strict intersection today. The only consumer surface that observes the collapse is hand-written literal calls in `test-d.ts` and developer ergonomics in IDE autocomplete.

### Finding 6: Render options aggregation has its own (lesser) collapse — call it R11.b

`CollectRenderOptions<presets.all()>` distributes to `OcctRender | OpenscadRender | Record<string, unknown>` (because jscad/manifold/zoo/tau don't declare `renderSchema`, the phantom defaults to `Record<string, unknown>`). The index signature in `Record<string, unknown>` **swallows** the more specific kernels — `renderOptions` effectively accepts any object. Excess property checks are gone for the preset path. Not an annihilation, but a parallel symmetry bug worth fixing in the same pass.

### Finding 7: `MergedEdgesForTranscoder` JSDoc is now incorrect

The current comment claims the merge "mirror[s] the runtime JSON Schema merge in `mergeJsonSchemas`". With multi-kernel intersection, the compile-time type does **not** mirror the per-route runtime merge — they diverge precisely on the `presets.all()` aggregate. The doc needs to be honest about which model is being represented.

### Finding 8: `OcctTessellation` vs `OpenscadTessellation` collide on the same key but coexist safely

OCCT and OpenSCAD both declare `tessellation` under `glb`/`gltf`, but with disjoint inner fields (`linearTolerance`/`angularTolerance` vs `segments`/`minimumAngle`/`minimumSize`). All inner fields use `.default(...)`, so `z.input` makes them optional. The intersected inner type is `{ linearTolerance?, angularTolerance?, segments?, minimumAngle?, minimumSize? }` — trivially satisfied by `{}` and accepting any subset. This finding is significant because it shows the **non-empty** intersection case behaves well; the only pathology is the empty-object placeholder.

### Finding 9: `z.unknown()` is the safe placeholder swap; `z.object({}).passthrough()` is not viable in Zod 4

Already proven during the converter fix: `z.unknown()` resolves to `unknown`, and `T & unknown ≡ T`. Behavior matrix:

| Placeholder         | `z.input` type          | `T & placeholder`        | JSON Schema output                           | Runtime parse({})    |
| ------------------- | ----------------------- | ------------------------ | -------------------------------------------- | -------------------- |
| `z.object({})`      | `Record<string, never>` | `T & never` (collapses)  | `{type:'object', properties:{}, ...}`        | `{}`                 |
| `z.unknown()`       | `unknown`               | `T` (preserved)          | `{}`                                         | `{}`                 |
| `z.looseObject({})` | `{}` + index signature  | works but adds index sig | `{type:'object', additionalProperties:true}` | passes through input |

`z.unknown()` also survives `mergeJsonSchemas` cleanly: the `Object.keys(empty).length === 0` branch fires and the **other** schema is kept verbatim — the empty kernel placeholder never pollutes the merged JSON Schema. Both runtime and UI form rendering are unchanged.

### Finding 10: `presets.all()` return type is preserved, not erased

The `// preset returns erased plugin types` comment on `presets.all()` is misleading — the function has no return annotation, so TS infers the literal tuple and phantom types propagate to `createRuntimeClient`. The deferred `Record<string, never>` errors only manifest because the phantoms **do** propagate. Misleading comment to fix while in the area.

### Finding 11: `Record<string, never>` is type-level detectable; the original "Medium risk" grading was overstated

The original trade-off table marked Approach C ("type-level filter") as `Medium risk: detecting `Record<string, never>` is brittle in TS`. On closer inspection, a robust two-step idiom distinguishes `Record<string, never>` from every other shape we care about:

```typescript
type IsRecordStringNever<T> = string extends keyof T ? ([T[string]] extends [never] ? true : false) : false;
```

The `[T[string]] extends [never]` tuple wrap blocks distributive conditional behavior so a union value type does not split the test. Verification matrix (each row hand-evaluated against the TS type checker):

| Input `T`                      | `string extends keyof T`       | `[T[string]] extends [never]`       | Result  | Should detect? |
| ------------------------------ | ------------------------------ | ----------------------------------- | ------- | -------------- |
| `Record<string, never>`        | `string extends string` → true | `[never] extends [never]` → true    | `true`  | yes            |
| `Record<string, unknown>`      | `string extends string` → true | `[unknown] extends [never]` → false | `false` | no             |
| `{ a: 1 }`                     | `string extends 'a'` → false   | (short-circuit)                     | `false` | no             |
| `{}`                           | `string extends never` → false | (short-circuit)                     | `false` | no             |
| `{ [k: string]: number }`      | true                           | `[number] extends [never]` → false  | `false` | no             |
| `OcctGlbOptions` (real schema) | false                          | (short-circuit)                     | `false` | no             |

The detector is precise enough to filter the exact `Record<string, never>` shape that `z.input<z.object({})>` produces while leaving every other contributor untouched. With this primitive in hand, Approach C becomes the lowest-friction fix in the matrix — it preserves the documented intersection contract from Finding 2, requires no schema churn, and gives kernel authors the incremental-extend DX they expect from `z.object({})`.

## Trade-offs — Candidate Fixes

| #     | Approach                                                                            | Files touched               | Author DX (kernel-side)                                       | Consumer compile-time strictness                     | Runtime impact | Risk                                                     |
| ----- | ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | -------------- | -------------------------------------------------------- |
| **C** | **Type-level filter (`FilterEmpty<T>`) inside `CollectFormatMap`**                  | 1 type + tests + JSDoc      | Best — keep `z.object({})`, extend literal as schema grows    | Preserves Finding 2 intersection contract            | None           | Low (Finding 11 — detection idiom is precise)            |
| A     | Switch `CollectFormatMap` to union algebra (mirror `CollectRenderOptions`)          | 1 type + 1 test + JSDoc     | Same DX as C, but consumer behavior changes                   | Looser: union; mix-and-match across kernels rejected | None           | Low: 1 test rewrite, 1 doc update — but contract changes |
| B     | Replace `z.object({})` placeholders with shared `noKernelOptions` (= `z.unknown()`) | 5 schema files              | Worse — authors must remember to swap back when adding fields | Same intersection algebra (preserved)                | None           | Low: schema swap; but ongoing author burden              |
| D     | Per-kernel narrowed `client.export` (active-kernel type parameter)                  | API redesign across runtime | Highest                                                       | Highest                                              | None           | Very high: breaks consumer API                           |
| E     | Document and require explicit casts                                                 | 1 doc update                | Worst                                                         | Same (broken)                                        | None           | Zero (but doesn't fix anything)                          |

**Recommended target = C** (revised from prior recommendation of A). Three reasons drive the pivot:

1. **Author DX**. `z.object({})` is the natural Zod placeholder — kernel authors can incrementally add properties (`z.object({ binary: z.boolean().optional() })`) without renaming the import or remembering "swap back when you add fields". Approach B forces a schema-import rename whenever a kernel starts declaring real options.
2. **Contract preservation**. Approach A changes the documented intersection contract in Finding 2 (`it('should intersect overlapping format options from multiple plugins')`). Under union algebra, callers can no longer mix-and-match fields from multiple kernels for the same format (e.g., `{ tessellation: { linearTolerance, segments } }` becomes a type error even when both fields are individually accepted at runtime). Intersection is strictly more permissive for the multi-kernel mix case and matches what `mergeJsonSchemas` does at runtime.
3. **Precision of detection**. Finding 11 demonstrates that `Record<string, never>` is precisely detectable; the "Medium risk" label was overstated. The two-step `string extends keyof T && [T[string]] extends [never]` idiom is unambiguous against every shape we encounter (real schemas, defaults, index-signatured types).

Approach A remains a viable secondary option if the team later decides that union semantics better match the runtime model. Approach B is no longer recommended (ongoing author burden, no algebraic benefit over C).

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                              | Priority | Effort  | Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------ |
| R12 | Add `IsRecordStringNever<T>` + `FilterEmpty<T>` helpers in `plugin-types.ts`; apply `FilterEmpty` to each contributor inside `CollectFormatMap`'s intersection. Preserves Finding 2 contract; allows `z.object({})` to remain the kernel-author placeholder                                                                                         | P1       | Low     | High   |
| R13 | ~~Replace `z.object({})` placeholders with `noKernelOptions = z.unknown()` across 5 kernels~~ — **CANCELLED**. Approach C (R12) makes this unnecessary. `z.object({})` is preserved as the canonical placeholder for better DX (incremental literal extension as schemas grow). Documented as a non-recommended fallback in Trade-offs (Approach B) | —        | —       | —      |
| R14 | Fix `MergedEdgesForTranscoder` JSDoc — drop the "mirroring `mergeJsonSchemas`" claim; describe the FilterEmpty-aware algebra accurately                                                                                                                                                                                                             | P2       | Trivial | Medium |
| R15 | Remove the misleading `// preset returns erased plugin types` comments on `presets.all()` (return type is preserved by inference)                                                                                                                                                                                                                   | P3       | Trivial | Low    |
| R16 | (R11.b) Apply the same filter pattern (`FilterDefaultRenderOptions<T>`) inside `CollectRenderOptions` to drop the `Record<string, unknown>` phantom from the union when at least one kernel declares a concrete `renderSchema`; preserve fallback to `Record<string, unknown>` only when all contributors are the default                           | P2       | Low     | Medium |
| R17 | Re-enable the `presets.all() — transcoded export type safety` block in `define-plugin.test-d.ts` once R12 lands (and add positive cases for `glb`, `gltf`, `step`, `3mf`, `usdz`)                                                                                                                                                                   | P1       | Low     | High   |
| R18 | Add a type-level invariant test in `define-plugin.test-d.ts` that asserts `CollectFormatMap` over `presets.all()` never produces a value type satisfying `IsRecordStringNever` for any format key. Acts as a regression guard regardless of how kernel authors choose to express their placeholders                                                 | P2       | Low     | Medium |

## Code Examples

### R12 — `FilterEmpty` primitives

```typescript
// packages/runtime/src/plugins/plugin-types.ts

/**
 * Detects the exact `Record<string, never>` shape that Zod 4 infers from
 * `z.input<z.object({})>`. The `[T[string]] extends [never]` tuple wrap
 * blocks distributive conditional behavior so a union value type does not
 * split the test. See Finding 11 for the full verification matrix.
 *
 * @internal
 */
type IsRecordStringNever<T> = string extends keyof T ? ([T[string]] extends [never] ? true : false) : false;

/**
 * Replaces the annihilator `Record<string, never>` with `never`. Inside a
 * union of contributor types, `never` is absorbed (`T | never ≡ T`), so
 * concrete schemas survive untouched. When every contributor is the
 * placeholder, the union collapses to `never` and `UnionToIntersection<never>`
 * resolves to `unknown` — the natural "no constraints declared" fallback.
 * Every other shape — concrete schemas, `Record<string, unknown>`, `{}`,
 * indexed types — is passed through untouched.
 *
 * @internal
 */
type FilterEmpty<T> = IsRecordStringNever<T> extends true ? never : T;
```

> **Why `never` and not `unknown`?** `unknown` would be the natural identity element for intersection (`T & unknown ≡ T`), but the TypeScript checker eagerly simplifies `T | unknown ≡ unknown` _before_ the surrounding `UnionToIntersection<…>` runs, so the identity is lost the moment the contributors are unioned. `never` works in the dual direction: it is absorbed by union (`T | never ≡ T`) and `UnionToIntersection<never>` is `unknown`, giving the same "no constraints" result for the all-placeholder case without ever hitting the eager-collapse pathway.

### R12 — Apply `FilterEmpty` inside `CollectFormatMap`

```typescript
// packages/runtime/src/plugins/plugin-types.ts

/**
 * Per-plugin contribution for a single format key.
 *
 * Wraps the per-plugin extraction in a dedicated helper so the conditional
 * `P extends KernelPlugin<infer M, any>` operates on a naked type parameter
 * `P` and therefore distributes over union inputs. Without this wrapper the
 * indexed access `Plugins[number]` is not a naked parameter, so the
 * conditional matches the union as a whole and `M` is inferred to a union of
 * value types — defeating `FilterEmpty<T>`.
 *
 * Returns `never` when the plugin does not declare the key, or when its
 * options resolve to the `Record<string, never>` placeholder. `never` is
 * absorbed by the surrounding union and produces a clean intersection at the
 * `UnionToIntersection` step in `CollectFormatMap`.
 *
 * @internal
 */
type ContributorFor<P, K extends string> =
  P extends KernelPlugin<infer M, any> ? (K extends keyof M ? FilterEmpty<M[K]> : never) : never;

export type CollectFormatMap<Plugins extends readonly KernelPlugin<any, any>[]> = {
  [K in keyof UnionToIntersection<Plugins[number] extends KernelPlugin<infer M, any> ? M : never>]: UnionToIntersection<
    ContributorFor<Plugins[number], K & string>
  >;
};
```

The outer `keyof UnionToIntersection<...>` is unchanged — it still produces the union of all format keys across plugins. The inner `UnionToIntersection<…>` over contributors is also unchanged (Finding 2's contract is preserved). Two cooperating changes make `z.object({})` placeholders disappear cleanly:

1. `ContributorFor<P, K>` exposes `P` as a naked type parameter, which forces the conditional `P extends KernelPlugin<infer M, any>` to distribute over `Plugins[number]` even when that resolves to a union. Without this hop the conditional matches the union as a whole and infers `M` as a union of value types, which silently widens `M[K]` and prevents `FilterEmpty` from firing.
2. `FilterEmpty<M[K]>` rewrites the `Record<string, never>` annihilator to `never`, which is absorbed by the surrounding union (`T | never ≡ T`). When every contributor is the placeholder, the union collapses to `never` and `UnionToIntersection<never>` evaluates to `unknown`, giving the expected "no constraints declared" fallback.

### R12 — Trace through `presets.all().glb`

`presets.all().kernels` is typed as a general array of unions (`(OpenscadPlugin | ZooPlugin | … | TauPlugin)[]`), not a tuple, because `all()` lets inference assign the array literal. The fix works for that shape because `ContributorFor` distributes over `Plugins[number]`:

```
ContributorFor<OcctPlugin,     'glb'>  → OcctGlbOptions
ContributorFor<OcctPlugin,     'glb'>  → OcctGlbOptions
ContributorFor<OpenscadPlugin, 'glb'>  → OpenscadGlbOptions
ContributorFor<ManifoldPlugin, 'glb'>  → never   // FilterEmpty(Record<string, never>)
ContributorFor<ZooPlugin,      'glb'>  → never
ContributorFor<TauPlugin,      'glb'>  → never
ContributorFor<JscadPlugin,    'glb'>  → never

Union:
  OcctGlbOptions | OcctGlbOptions | OpenscadGlbOptions | never | never | never | never
≡ OcctGlbOptions | OpenscadGlbOptions     // never absorbed by `|`

UnionToIntersection:
  OcctGlbOptions & OpenscadGlbOptions
```

Which (per Finding 8) is `{ tessellation?: { linearTolerance?, angularTolerance?, segments?, minimumAngle?, minimumSize? }, coordinateSystem?: 'y-up' | 'z-up', unit?: ... }`. Callers can pass any subset of fields from any contributing kernel — exactly mirroring how `mergeJsonSchemas` behaves at runtime.

### R12 — Transcoder propagation under FilterEmpty

For transcoder targets (e.g., `3mf` extending from `glb`), `MergedEdgesForTranscoder` intersects the source-format options with the edge options:

```
(OcctGlbOptions & OpenscadGlbOptions) & ThreeMfEdgeOpts
= { tessellation?, coordinateSystem?, unit?, ...edgeOpts }
```

No `Record<string, never>` ever reaches the transcoder layer because it was filtered upstream in `CollectFormatMap`. The previous "everything collapses to never" failure mode is removed at the source.

### R12 — Existing intersection test continues to pass

```typescript
// packages/runtime/src/types/define-plugin.test-d.ts
it('should intersect overlapping format options from multiple plugins', () => {
  type PluginA = KernelPlugin<{ stl: { binary: boolean } }>;
  type PluginB = KernelPlugin<{ stl: { quality: number } }>;

  type Merged = CollectFormatMap<[PluginA, PluginB]>;
  expectTypeOf<Merged>().toEqualTypeOf<{ stl: { binary: boolean } & { quality: number } }>();
});
```

Neither `{ binary: boolean }` nor `{ quality: number }` is `Record<string, never>`, so neither is filtered. Intersection proceeds as before.

### R12 — New tests covering the placeholder filter

```typescript
// packages/runtime/src/types/define-plugin.test-d.ts
it('should drop Record<string, never> contributors from the intersection', () => {
  type PluginA = KernelPlugin<{ glb: { tessellation: { linearTolerance: number } } }>;
  type PluginB = KernelPlugin<{ glb: Record<string, never> }>;

  type Merged = CollectFormatMap<[PluginA, PluginB]>;
  expectTypeOf<Merged>().toEqualTypeOf<{ glb: { tessellation: { linearTolerance: number } } }>();
});

it('should fall back to unknown only when every contributor is empty', () => {
  type PluginA = KernelPlugin<{ glb: Record<string, never> }>;
  type PluginB = KernelPlugin<{ glb: Record<string, never> }>;

  type Merged = CollectFormatMap<[PluginA, PluginB]>;
  expectTypeOf<Merged>().toEqualTypeOf<{ glb: unknown }>();
});
```

### R16 — Mirror filter for `CollectRenderOptions`

```typescript
// packages/runtime/src/plugins/plugin-types.ts

/**
 * Drops the default `Record<string, unknown>` phantom from a render-options
 * union when it would otherwise swallow more specific contributors. Falls
 * back to `Record<string, unknown>` only when every contributor is the
 * default phantom.
 *
 * @internal
 */
type FilterDefaultRender<T> = T extends Record<string, unknown> ? (Record<string, unknown> extends T ? never : T) : T;

export type CollectRenderOptions<Plugins extends readonly KernelPlugin<any, any>[]> = [
  Plugins[number] extends KernelPlugin<any, infer R> ? FilterDefaultRender<R> : never,
] extends [never]
  ? Record<string, unknown>
  : Plugins[number] extends KernelPlugin<any, infer R>
    ? FilterDefaultRender<R>
    : never;
```

### R18 — Type-level invariant guard

```typescript
// packages/runtime/src/types/define-plugin.test-d.ts

// Locally-redeclared structural copy of the internal `IsRecordStringNever<T>`
// detector — the test asserts the public contract independently of the
// production helper's name or location.
type IsRecordStringNeverContract<T> = string extends keyof T ? ([T[string]] extends [never] ? true : false) : false;

it('should never produce Record<string, never> for any format key in CollectFormatMap<presets.all()>', () => {
  type AllPlugins = ReturnType<typeof presets.all>['kernels'];
  type FormatMap = CollectFormatMap<AllPlugins>;

  type AnnihilatedKeys = {
    [K in keyof FormatMap]: IsRecordStringNeverContract<FormatMap[K]> extends true ? K : never;
  }[keyof FormatMap];

  expectTypeOf<AnnihilatedKeys>().toEqualTypeOf<never>();
});
```

This guard fires at compile time the moment any new kernel registration causes a format to collapse to `Record<string, never>`, regardless of whether the author used `z.object({})`, `z.record(z.string(), z.never())`, or any other shape that resolves to the annihilator.

## Diagrams

### Before — Intersection collapses on placeholder

```
presets.all() kernels:
  replicad     -> { glb: { tessellation, coordinateSystem } }
  opencascade  -> { glb: { tessellation, coordinateSystem } }
  openscad     -> { glb: { tessellation, coordinateSystem } }
  manifold     -> { glb: Record<string, never> }   <-- annihilator
  zoo          -> { glb: Record<string, never> }   <-- annihilator
  tau          -> { glb: Record<string, never> }   <-- annihilator
  jscad        -> { glb: Record<string, never> }   <-- annihilator

CollectFormatMap['glb']
  = UnionToIntersection<all of the above .glb>
  = OcctGlb & OcctGlb & OpenscadGlb & R<s,n> & R<s,n> & R<s,n> & R<s,n>
  = Record<string, never>                          <-- collapse

client.export('glb', { tessellation: ... })        // ERROR
```

### After (R12 via FilterEmpty) — Annihilator filtered, intersection preserved

```
For each contributor M[K] dispatched via ContributorFor<P, K>:
  FilterEmpty<M[K]> =
    IsRecordStringNever<M[K]> extends true ? never : M[K]

CollectFormatMap['glb']
  = UnionToIntersection<
      ContributorFor<OcctPlugin,     'glb'>  // OcctGlb (passes through)
    | ContributorFor<OcctPlugin,     'glb'>  // OcctGlb
    | ContributorFor<OpenscadPlugin, 'glb'>  // OpenscadGlb
    | ContributorFor<ManifoldPlugin, 'glb'>  // never (filtered, then absorbed by `|`)
    | ContributorFor<ZooPlugin,      'glb'>  // never
    | ContributorFor<TauPlugin,      'glb'>  // never
    | ContributorFor<JscadPlugin,    'glb'>  // never
  >
  = UnionToIntersection< OcctGlb | OpenscadGlb >   <-- never absorbed by union
  = OcctGlb & OpenscadGlb                          <-- Finding 2 contract preserved

client.export('glb', { tessellation: { linearTolerance: 0.01 } })           // OK
client.export('glb', { tessellation: { segments: 64 } })                    // OK
client.export('glb', { tessellation: { linearTolerance: 0.01, segments: 64 } }) // OK (mix-and-match per Finding 8)
client.export('glb', { coordinateSystem: 'y-up', tessellation: { ... } })   // OK
client.export('glb', {})                                                    // OK
client.export('glb', { foo: 'bar' })                                        // ERROR (excess prop)
```

### Comparison — Approach A (union) vs Approach C (FilterEmpty)

|                                                                         | Approach A (union)               | Approach C (FilterEmpty)              |
| ----------------------------------------------------------------------- | -------------------------------- | ------------------------------------- |
| `client.export('glb', { tessellation: { linearTolerance, segments } })` | ERROR (no single branch matches) | OK (intersection accepts both fields) |
| Finding 2 test (intersect overlapping)                                  | Must be rewritten to union       | Continues to pass unchanged           |
| `z.object({})` author DX                                                | Preserved                        | Preserved                             |
| Mirrors `mergeJsonSchemas` runtime                                      | No (runtime accepts mixed)       | Yes                                   |
| Symmetry with `CollectRenderOptions`                                    | Higher (both unions)             | Lower (filter idiom in both)          |

## Scope and Non-Goals

**In scope**: The compile-time `FilterEmpty<T>` primitive and its application inside `CollectFormatMap` and `CollectRenderOptions`; the `MergedEdgesForTranscoder` JSDoc accuracy under the filter; the regression guards that prevent reintroduction of the `Record<string, never>` annihilator.

**Out of scope**:

- Active-kernel narrowing on `client.export` (Approach D). Worth its own design doc; not needed for this fix.
- Changing the runtime per-route validation. `mergeJsonSchemas` is correct as is.
- Per-kernel options schemas (`optionsSchema`) on the constructor side. Those are inferred per kernel, not aggregated.
- Switching the kernel-side placeholder away from `z.object({})`. Preserved as canonical (Recommendation R13 cancelled in favor of R12).

## References

- `packages/runtime/src/plugins/plugin-types.ts` — `CollectFormatMap`, `CollectRenderOptions`, `MergedEdgesForTranscoder`, `MergeExportMap`, `UnionToIntersection`
- `packages/runtime/src/framework/kernel-worker.ts` — `mergeJsonSchemas`, `deriveJsonSchema`
- `packages/runtime/src/kernels/*/*.schemas.ts` — annihilating placeholder inventory
- `packages/runtime/src/plugins/presets.ts` — `presets.all()` aggregation surface
- `packages/runtime/src/types/define-plugin.test-d.ts:1306-1312` — intersection contract test paired with R12
- Related: `docs/research/define-transcoder-type-safety.md` (R9, R10 RESOLVED; R11 OPEN — closed by this document)
- Related: `docs/research/export-pipeline-v5.md`
