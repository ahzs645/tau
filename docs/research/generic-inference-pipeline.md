---
title: 'Generic Inference Pipeline'
description: 'Research into TypeScript generic inference chain patterns used by leading frameworks, with recommendations for achieving zero-annotation type propagation in the kernel plugin system.'
status: draft
created: '2026-04-15'
updated: '2026-04-15'
category: architecture
related:
  - docs/research/kernel-plugin-type-linkage.md
  - docs/research/lazy-capabilities-manifest.md
  - docs/policy/library-api-policy.md
---

# Generic Inference Pipeline

Investigation into how leading TypeScript frameworks carry "bags" of generic type information through plugin systems and fluent APIs, with specific recommendations for achieving zero-annotation type propagation in Tau's kernel plugin architecture.

## Executive Summary

The current `createKernelPlugin` API suffers from TypeScript's partial-inference limitation: when `Options` is provided as an explicit type parameter (`createKernelPlugin<ReplicadOptions>({...})`), the `ExportSchemas` generic cannot be simultaneously inferred from the config object, causing `FormatMap` to collapse to `{}`. Source-level analysis of six leading TypeScript frameworks (tRPC, Hono, Effect-TS, Drizzle ORM, Elysia, Zod) reveals three dominant patterns for carrying generic bags: builder chains, intersection accumulation, and phantom property inference. The recommended solution for Tau combines the **config-as-inference-source** pattern (Drizzle/Zod) with **phantom property carriers** (already present via `__exportSchemas`): move each kernel's `optionsSchema` to `*.schemas.ts` alongside `exportSchemas`, then have `createKernelPlugin` infer both `Options` and `FormatMap` from the config object with zero explicit type parameters.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Framework Analysis](#framework-analysis)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Trade-offs](#trade-offs)
- [References](#references)

## Problem Statement

Two constraints collide in the current `createKernelPlugin` design:

1. **Options type**: Some kernels accept configuration options (e.g., `ReplicadOptions = { wasm?: 'single' | ReplicadWasmConfig }`). The factory function's parameter type must carry this information.
2. **FormatMap type**: The plugin must carry per-format export option types as a phantom generic (`KernelPlugin<FormatMap>`) so `RuntimeClient.export()` can type-check options.

The current overloads attempt to serve both:

```typescript
// Overload 1: no Options, ExportSchemas inferred ✓
createKernelPlugin<ExportSchemas>(config): () => KernelPlugin<ResolveFormatMap<ExportSchemas>>;

// Overload 2: explicit Options, ExportSchemas inferred ✗
createKernelPlugin<Options, ExportSchemas>(config): (options?) => KernelPlugin<ResolveFormatMap<ExportSchemas>>;
```

When a plugin author writes `createKernelPlugin<ReplicadOptions>({...})`, TypeScript resolves `Options = ReplicadOptions` but falls back to the default for `ExportSchemas` (`Record<string, z.ZodType>`), which resolves `FormatMap` to `{}`. This is documented in the existing type test:

```typescript
it('should lose FormatMap inference when Options type param is explicit', () => {
  const factory = createKernelPlugin<{ debug?: boolean }>((options) => ({
    id: 'test',
    moduleUrl: 'test.js',
    extensions: ['ts'],
    exportSchemas: { stl: stlSchema },
  }));
  const plugin = factory();
  expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>(); // FormatMap lost!
});
```

The prior implementation plan proposed explicit `FormatMap` type parameters (`createKernelPlugin<ReplicadOptions, ReplicadFormatMap>({...})`). This contradicts Library API Policy §16 (type-safe options helpers via inference, not explicit imports) and the principle that consumer DX should never require manual type annotation.

## Methodology

1. Searched for TypeScript generic inference chain patterns, builder patterns, type-level state machines, and "type bag" patterns in 2025–2026 literature
2. Cloned and explored source code of six leading TypeScript frameworks via `pnpm repos add --clone`:
   - **tRPC** (`repos/trpc`) — end-to-end typesafe APIs
   - **Hono** (`repos/hono`) — TypeScript-first web framework
   - **Effect-TS** (`repos/effect`) — type-level programming framework
   - **Drizzle ORM** (`repos/drizzle-orm`) — TypeScript SQL ORM
   - **Elysia** (`repos/elysia`) — TypeScript web framework with full type inference
   - **Zod** (`repos/zod`) — schema validation with static type inference
3. For each framework, analyzed: generic parameter structure, inference techniques, phantom types, accumulation patterns, limitations, and consumer DX
4. Mapped findings to Tau's `createKernelPlugin` → `KernelPlugin` → `RuntimeClient` type pipeline to identify which patterns apply

## Findings

### Finding 1: Three dominant patterns for carrying generic bags

Analysis of six frameworks reveals three patterns for propagating type information through plugin/middleware chains:

| Pattern                        | Frameworks      | Mechanism                                                                                | Trade-off                                  |
| ------------------------------ | --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Builder chain**              | tRPC, Effect-TS | Each method returns a new generic instance with refined type params                      | Best inference; verbose internal types     |
| **Intersection accumulation**  | Hono, Elysia    | Fluent methods `return this as any` but declare narrower return types via `&`            | Good inference; risk of `any` poisoning    |
| **Phantom property inference** | Drizzle, Zod    | `declare` fields / `_zod` internals carry computed types; inference from object literals | Best for config objects; no builder needed |

### Finding 2: tRPC — Builder + `_def` phantom bag

tRPC uses a class-based builder where each step returns a new generic instance:

```typescript
// repos/trpc/packages/server/src/.../initTRPC.ts
class TRPCBuilder<TContext extends object, TMeta extends object> {
  context<TNew>() {
    return new TRPCBuilder<Unwrap<TNew>, TMeta>();
  }
  meta<TNew>() {
    return new TRPCBuilder<TContext, TNew>();
  }
  create(opts?) {
    /* fixes all types, returns TRPCRootObject */
  }
}
```

Procedures carry a **`$types` phantom field** set to `null as any` at runtime:

```typescript
// repos/trpc/packages/server/src/.../procedure.ts
interface Procedure<TType, TDef> {
  _def: { $types: { input: TDef['input']; output: TDef['output'] } /* ... */ };
}
// Runtime: _def.$types = null as any
```

**Key insight**: Runtime values are `null as any`; the type system carries all information via declared interface shapes. Consumer inference works because `inferRouterInputs<TRouter>` recursively walks `TRouter['_def']['record']`.

**Applicability to Tau**: The builder pattern is unnecessary for `createKernelPlugin` — configuration is a single call, not a chain. But the `$types` phantom pattern directly parallels `KernelPlugin[__exportSchemas]`.

### Finding 3: Hono — Intersection accumulation with `IntersectNonAnyTypes`

Hono accumulates environment and schema types via intersection on every route/middleware registration:

```typescript
// repos/hono/src/types.ts — route handler overload
get<E2, P, I, R>(handler: H<E2, P, I, R>): HonoBase<
  IntersectNonAnyTypes<[E, E2]>,         // Env accumulates
  S & ToSchema<M, P, I, MergeTypedResponse<R>>,  // Schema accumulates
  BasePath, CurrentPath
>
```

The `IntersectNonAnyTypes` utility prevents `any` from collapsing accumulated types:

```typescript
// repos/hono/src/types.ts
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>;
type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {};
```

**Key insight**: Runtime implementation uses `return this as any` everywhere; type safety is entirely in the declared return types of overloads.

**Applicability to Tau**: `CollectFormatMap` already uses intersection (via `UnionToIntersection`) to merge FormatMaps from multiple plugins. The `IntersectNonAnyTypes` pattern is worth adopting to prevent `any` poisoning in the collection pipeline.

### Finding 4: Elysia — Seven-parameter type bag with `const in out`

Elysia carries seven generic parameters on the main class, each an object "slice":

```typescript
// repos/elysia/src/index.ts
class Elysia<
  const in out BasePath extends string = '',
  const in out Singleton extends SingletonBase = { decorator: {}; store: {}; derive: {}; resolve: {} },
  const in out Definitions extends DefinitionBase = { typebox: {}; error: {} },
  const in out Metadata extends MetadataBase = { schema: {} /* ... */ },
  const in out Routes extends RouteBase = {},
  const in out Ephemeral extends EphemeralType = { derive: {} /* ... */ },
  const in out Volatile extends EphemeralType = { derive: {} /* ... */ },
> {
  '~Prefix' = '' as BasePath; // phantom property
  '~Singleton' = null as unknown as Singleton;
  '~Routes' = null as unknown as Routes;
  // ...
}
```

Composition via `.use(plugin)` intersects each slice of the plugin's bag into the host's bag:

```typescript
use<NewElysia extends AnyElysia>(instance: NewElysia): Elysia<
  BasePath,
  { decorator: Singleton['decorator'] & NewElysia['~Singleton']['decorator']; /* ... */ },
  Definitions & NewElysia['~Definitions'],
  // ...
>
```

**Key insight**: The `~Prefix` / `~Singleton` / `~Routes` phantom properties use `null as unknown as T` to carry type-only information readable by other type-level code. The `const in out` modifiers enable inference of literal types.

**Applicability to Tau**: The phantom tilde-property pattern (`~X = null as unknown as T`) is a cleaner alternative to symbol-branded phantoms. However, `KernelPlugin` is a plain object type (not a class), so `declare` fields or the existing `[__exportSchemas]` symbol approach is more appropriate.

### Finding 5: Drizzle — Phantom `$inferSelect` from config object inference

Drizzle's table factory infers column types entirely from the object literal:

```typescript
// repos/drizzle-orm/drizzle-orm/src/pg-core/table.ts
function pgTable<TName, TColumnsMap extends Record<string, PgColumnBuilderBase>>(
  name: TName,
  columns: TColumnsMap,
): PgTableWithColumns<{ name: TName; columns: BuildColumns<TName, TColumnsMap, 'pg'> }> {
```

The resulting table carries phantom inference fields:

```typescript
// repos/drizzle-orm/drizzle-orm/src/table.ts
class Table<T extends TableConfig> {
  declare readonly $inferSelect: InferSelectModel<Table<T>>;
  declare readonly $inferInsert: InferInsertModel<Table<T>>;
}
```

`InferSelectModel` is a recursive mapped type that walks `T['columns']` and resolves each column's data type, nullability, and default status.

**Key insight**: The object literal IS the type source. `TColumnsMap` is inferred from the `columns` argument, then `BuildColumns` computes the full column types. No explicit type parameters needed from the consumer.

**Applicability to Tau**: This is the most directly applicable pattern. `createKernelPlugin` should infer both `Options` and `FormatMap` from the config object's properties, just as `pgTable` infers column types from the columns argument.

### Finding 6: Zod — `_zod` internals as universal inference carrier

Every Zod schema carries type information on a `_zod` internal bag:

```typescript
// repos/zod/packages/zod/src/v4/core/schemas.ts
type $ZodType<O, I, Internals extends $ZodTypeInternals<O, I>> = {
  _zod: Internals; // carries output, input, def, config
};

// z.infer<T> is literally:
type output<T> = T extends { _zod: { output: any } } ? T['_zod']['output'] : unknown;
export type { output as infer };
```

For objects, the output type is computed via a mapped type over the shape's children:

```typescript
// repos/zod/packages/zod/src/v4/core/schemas.ts
type $InferObjectOutput<T extends $ZodLooseShape> = {
  [k in keyof T as T[k] extends OptionalOutSchema ? never : k]: T[k]['_zod']['output'];
} & {
  [k in keyof T as T[k] extends OptionalOutSchema ? k : never]?: T[k]['_zod']['output'];
};
```

**Key insight**: Zod's `toJSONSchema()` preserves the generic `T` in its return type via `ZodStandardJSONSchemaPayload<T>`, but the JSON Schema data itself has no generics — it's the TypeScript return type that carries the link.

**Applicability to Tau**: If `createKernelPlugin` accepts an `optionsSchema` (Zod), the Options type can be inferred via `z.input<typeof optionsSchema>` with no explicit annotation. This is the Zod-native pattern for deriving types from schemas.

### Finding 7: TypeScript partial inference — the root constraint

TypeScript does not support partial inference of generic parameters. When any generic is explicitly provided, all others fall back to defaults:

```typescript
function f<A, B = unknown>(a: A, b: B): [A, B];
f<string>(1, 2); // A = string (explicit), B = unknown (default, NOT inferred as number)
```

This is not a bug but a deliberate design choice. The TypeScript team considered "propagated inference for free type parameters" ([PR #24626](https://github.com/Microsoft/TypeScript/pull/24626)) but did not merge it.

**Workarounds used by frameworks:**

| Workaround        | Used by      | Mechanism                                           |
| ----------------- | ------------ | --------------------------------------------------- |
| Builder methods   | tRPC         | Each method fixes one type param                    |
| Curried functions | Effect-TS    | `f(a)(b)` — each call site is a full inference site |
| Config-as-source  | Drizzle, Zod | All type info inferred from a single argument       |
| `NoInfer<T>`      | tRPC, Elysia | Prevents inference from specific positions          |
| Overload grids    | Hono         | Massive overload sets cover all arity combinations  |

### Finding 8: Config-as-source resolves the Tau problem completely

The insight: if ALL type information needed by `createKernelPlugin` is present in the config object, TypeScript can infer ALL generics from a single argument with no explicit type parameters.

Currently, `Options` is NOT in the config — it's a separate generic. But each kernel already defines an `optionsSchema` (Zod) internally:

| Kernel      | Options type         | Has Zod optionsSchema? |
| ----------- | -------------------- | ---------------------- |
| replicad    | `ReplicadOptions`    | Yes (in kernel file)   |
| opencascade | `OpenCascadeOptions` | Yes (in kernel file)   |
| manifold    | `ManifoldOptions`    | Yes (in kernel file)   |
| zoo         | `ZooOptions`         | Yes (in kernel file)   |
| jscad       | None                 | No                     |
| tau         | None                 | No                     |
| openscad    | None                 | No                     |

Moving `optionsSchema` to `*.schemas.ts` and adding it to the `createKernelPlugin` config enables full inference:

```typescript
// replicad.schemas.ts
export const replicadOptionsSchema = z.object({
  wasm: z
    .union([z.literal('single'), z.object({ wasmUrl: z.string(), wasmBindingsUrl: z.string() })])
    .default('single'),
  tracing: z.enum(['summary', 'per-call']).default('summary'),
});
export const replicadExportSchemas = { stl: stlSchema, step: stepSchema, glb: glbSchema, gltf: gltfExportSchema };

// replicad.plugin.ts — zero explicit type parameters
import { replicadOptionsSchema, replicadExportSchemas } from './replicad.schemas.js';

export const replicad = createKernelPlugin({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  optionsSchema: replicadOptionsSchema, // Options inferred ← z.input<typeof schema>
  exportSchemas: replicadExportSchemas, // FormatMap inferred ← { stl: z.infer<...>, ... }
});
// Inferred type: (options?: ReplicadOptions) => KernelPlugin<{ stl: StlOptions; step: StepOptions; ... }>
```

## Recommendations

| #   | Action                                                                                 | Priority | Effort | Impact                                  |
| --- | -------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------- |
| R1  | Add `optionsSchema` field to `KernelPluginConfig`                                      | P0       | Medium | Eliminates partial-inference limitation |
| R2  | Infer `Options` from `optionsSchema` via `z.input` in `createKernelPlugin` overloads   | P0       | Medium | Zero-annotation plugin authorship       |
| R3  | Move `optionsSchema` from `*.kernel.ts` to `*.schemas.ts` for each kernel with options | P0       | Low    | Single source of truth                  |
| R4  | Use `NoInfer` on `optionsSchema` in config to prevent reverse inference                | P1       | Low    | Correctness                             |
| R5  | Add `IntersectNonAnyTypes` utility to prevent `any` poisoning in `CollectFormatMap`    | P2       | Low    | Robustness                              |
| R6  | Adopt `satisfies` + `as const` pattern for schema objects to preserve literal keys     | P1       | Low    | DX                                      |
| R7  | Document the inference pipeline for kernel plugin authors                              | P2       | Low    | Onboarding                              |

### R1: `optionsSchema` field

Add an optional `optionsSchema` field to `KernelPluginConfig` that accepts a `z.ZodType`. When present, the factory function's parameter type is inferred from it. When absent, the factory takes no parameters.

### R2: Overload restructuring

Replace the current two overloads with three:

```typescript
// 1. No options, no exports → () => KernelPlugin
createKernelPlugin(config: KernelPluginConfig): () => KernelPlugin;

// 2. No options, with exports → () => KernelPlugin<FormatMap>
createKernelPlugin<ES extends Record<string, z.ZodType>>(
  config: KernelPluginConfig & { exportSchemas: ES },
): () => KernelPlugin<InferFormatMap<ES>>;

// 3. With options (and optional exports) → (options?) => KernelPlugin<FormatMap>
createKernelPlugin<
  OS extends z.ZodType,
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(
  config: KernelPluginConfig & { optionsSchema: OS; exportSchemas?: ES },
): Partial<z.input<OS>> extends z.input<OS>
  ? (options?: z.input<OS>) => KernelPlugin<ResolveFormatMap<ES>>
  : (options: z.input<OS>) => KernelPlugin<ResolveFormatMap<ES>>;
```

All three overloads infer every generic from the config argument. No explicit type parameters.

### R3: Schema consolidation in `*.schemas.ts`

Each kernel with options moves its `optionsSchema` from the kernel file to the schemas file. The kernel file imports and uses it for runtime validation:

```typescript
// replicad.kernel.ts
import { replicadOptionsSchema } from './replicad.schemas.js';

export default defineKernel({
  onInitialize({ options }) {
    const parsed = replicadOptionsSchema.parse(options);
    // ...
  },
});
```

### R4: `NoInfer` for correct inference direction

The `optionsSchema` field should use `NoInfer` in the implementation overload to prevent TypeScript from inferring the schema type from the options parameter type (which would be circular):

```typescript
// Implementation signature
createKernelPlugin(config: { optionsSchema?: NoInfer<z.ZodType>; /* ... */ }): (options?: unknown) => KernelPlugin;
```

### R5: `IntersectNonAnyTypes` for `CollectFormatMap`

Adopt Hono's pattern to prevent `any`-typed plugins from poisoning the collected FormatMap:

```typescript
type IfAnyThenEmpty<T> = 0 extends 1 & T ? {} : T;
type CollectFormatMap<Plugins extends readonly KernelPlugin<any>[]> = {
  [K in keyof UnionToIntersection<
    Plugins[number] extends KernelPlugin<infer M> ? IfAnyThenEmpty<M> : never
  >]: /* ... */;
};
```

### R6: `satisfies` + `as const` for export schema objects

Use `as const satisfies Record<string, z.ZodType>` on export schema objects to preserve literal keys while validating the shape:

```typescript
export const replicadExportSchemas = {
  stl: stlExportSchema,
  step: stepExportSchema,
  glb: glbExportSchema,
  gltf: gltfExportSchema,
} as const satisfies Record<string, z.ZodType>;
```

This ensures TypeScript infers `{ readonly stl: typeof stlExportSchema; ... }` rather than `Record<string, z.ZodType>`.

## Code Examples

### Current: explicit type parameter loses FormatMap

```typescript
// replicad.plugin.ts (current)
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  exportSchemas: { stl: stlExportSchema, step: stepExportSchema, glb: glbExportSchema, gltf: gltfExportSchema },
});
// Result: (options?: ReplicadOptions) => KernelPlugin<{}>  ← FormatMap LOST
```

### Proposed: zero-annotation full inference

```typescript
// replicad.schemas.ts
export const replicadOptionsSchema = z.object({
  wasm: z
    .union([z.literal('single'), z.object({ wasmUrl: z.string(), wasmBindingsUrl: z.string() })])
    .default('single'),
  tracing: z.enum(['summary', 'per-call']).default('summary'),
  withSourceMapping: z.boolean().default(false),
});

export const replicadExportSchemas = {
  stl: stlExportSchema,
  step: stepExportSchema,
  glb: glbExportSchema,
  gltf: gltfExportSchema,
} as const satisfies Record<string, z.ZodType>;

// replicad.plugin.ts (proposed)
import { replicadOptionsSchema, replicadDetectPattern, replicadExportSchemas } from './replicad.schemas.js';

export const replicad = createKernelPlugin({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
  optionsSchema: replicadOptionsSchema,
  exportSchemas: replicadExportSchemas,
});
// Result: (options?: { wasm?: ...; tracing?: ...; withSourceMapping?: boolean })
//         => KernelPlugin<{ stl: StlOptions; step: StepOptions; glb: GlbOptions; gltf: GltfOptions }>
```

### Consumer code: unchanged, fully type-safe

```typescript
import { createRuntimeClient } from '@taucad/runtime';
import { replicad, openscad } from '@taucad/runtime/kernel';

const client = createRuntimeClient({
  kernels: [replicad(), openscad()],
});

// FormatMap = { stl: StlOptions; step: StepOptions; glb: GlbOptions; gltf: GltfOptions; ... }
await client.export('stl', { binary: true }); // ✓ type-checked
await client.export('stl', { binary: 'yes' }); // ✗ type error: string not boolean
await client.export('xyz'); // ✗ type error: 'xyz' not in FormatMap
```

### End-to-end inference pipeline

```
*.schemas.ts                    *.plugin.ts                        runtime-client.ts
─────────────                   ───────────                        ─────────────────
replicadOptionsSchema  ──────►  createKernelPlugin({               createRuntimeClient({
replicadExportSchemas  ──────►    optionsSchema: ──► Options         kernels: [replicad()],
                                  exportSchemas: ──► FormatMap     })
                                })                                   │
                                  │                                  ├─ Plugins tuple inferred
                                  ▼                                  │   KernelPlugin<FormatMap>[]
                              (options?) =>                          │
                              KernelPlugin<FormatMap>                ▼
                                  │                              RuntimeClient<
                                  │                                CollectFormatMap<Plugins>
                                  └────────────────────────────► >
                                                                   │
                                                                   ▼
                                                                 client.export(format, options)
                                                                   └─ format: keyof FormatMap
                                                                      options: FormatMap[format]
```

### `createKernelPlugin` implementation sketch

```typescript
type KernelPluginConfig<
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  OS extends z.ZodType | undefined = undefined,
> = Omit<KernelPlugin<any>, 'options' | 'exportSchemas' | 'renderSchema'> & {
  renderSchema?: z.ZodType;
  exportSchemas?: ES;
  optionsSchema?: OS;
};

// Overload 1: no optionsSchema → () => KernelPlugin<FM>
function createKernelPlugin<ES extends Record<string, z.ZodType>>(
  config: KernelPluginConfig<ES, undefined>,
): () => KernelPlugin<ResolveFormatMap<ES>>;

// Overload 2: with optionsSchema → (options?) => KernelPlugin<FM>
function createKernelPlugin<ES extends Record<string, z.ZodType>, OS extends z.ZodType>(
  config: KernelPluginConfig<ES, OS>,
): Partial<z.input<OS>> extends z.input<OS>
  ? (options?: z.input<OS>) => KernelPlugin<ResolveFormatMap<ES>>
  : (options: z.input<OS>) => KernelPlugin<ResolveFormatMap<ES>>;

// Implementation
function createKernelPlugin(
  config: KernelPluginConfig<Record<string, z.ZodType>, z.ZodType | undefined>,
): (options?: unknown) => KernelPlugin {
  return (options) => {
    const { exportSchemas: _es, renderSchema: _rs, optionsSchema: _os, ...rest } = config;
    return { ...rest, options: options as Record<string, unknown> };
  };
}
```

The implementation is trivially simple — `optionsSchema` and `exportSchemas` are consumed only by the type system, not at runtime (JSON Schema generation is deferred to the worker per the lazy capabilities manifest architecture).

## Trade-offs

| Approach                                                     | Inference                                        | DX                             | Bundle size            | Complexity |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------ | ---------------------- | ---------- |
| **Explicit `<Options, FormatMap>` type params** (prior plan) | Manual                                           | Poor — requires type imports   | No change              | Low        |
| **Builder pattern** (tRPC-style `.withOptions<T>()`)         | Partial                                          | Moderate — extra chaining step | No change              | Medium     |
| **Config builder function** `(options: Opts) => config`      | Full for FormatMap; param annotation for Options | Moderate                       | No change              | Low        |
| **`optionsSchema` in config** (recommended)                  | Full for both                                    | Best — zero annotations        | Schemas in main bundle | Low        |

### Bundle size consideration

Including `optionsSchema` Zod objects in the plugin means Zod schemas are bundled on the main thread. However:

1. The `exportSchemas` are already bundled on the main thread (current state)
2. `optionsSchema` are small (3–5 fields each)
3. Zod itself is already a main-thread dependency (used by `createKernelPlugin` today)
4. The lazy capabilities manifest eliminates `toJSONSchema()` from the main thread, which is the heavier operation

Net impact: schemas remain in the main bundle (same as today) but JSON Schema conversion moves to the worker (improvement).

### Schema duplication between plugin and kernel

With this approach, `exportSchemas` and `optionsSchema` values appear in both the plugin config and the kernel's `defineKernel()` call. But they're imported from the same `*.schemas.ts` file — a single declaration, consumed twice. This is structurally identical to how Drizzle's column definitions are used in both table creation and query builders: one definition, multiple consumption sites.

### Why not remove schemas from plugins entirely?

The lazy capabilities manifest research explored removing schemas from plugins. But for zero-annotation type inference, the schemas must be present somewhere in the plugin's config to serve as the inference source. The `optionsSchema` / `exportSchemas` values are not processed at runtime in the plugin — they're only read by the TypeScript compiler. The worker gets schemas from the kernel definition independently.

## References

- [TypeScript PR #24626](https://github.com/Microsoft/TypeScript/pull/24626) — Attempt at propagated inference for free type parameters (not merged)
- Related: `docs/research/kernel-plugin-type-linkage.md` — Schema duplication eigenquestion
- Related: `docs/research/lazy-capabilities-manifest.md` — Deferred JSON Schema generation
- Policy: `docs/policy/library-api-policy.md` — §16 type-safe options helpers, §8 plain objects

### Framework sources explored

| Framework | Repo path           | Key files                                                                                                           |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| tRPC      | `repos/trpc`        | `packages/server/src/.../initTRPC.ts`, `procedureBuilder.ts`, `procedure.ts`, `router.ts`, `clientish/inference.ts` |
| Hono      | `repos/hono`        | `src/hono-base.ts`, `src/types.ts`                                                                                  |
| Effect-TS | `repos/effect`      | `packages/effect/src/Effect.ts`, `Context.ts`, `Brand.ts`, `Function.ts`, `Types.ts`                                |
| Drizzle   | `repos/drizzle-orm` | `drizzle-orm/src/table.ts`, `column-builder.ts`, `pg-core/table.ts`, `query-builders/select.ts`                     |
| Elysia    | `repos/elysia`      | `src/index.ts`, `src/types.ts`, `src/context.ts`                                                                    |
| Zod       | `repos/zod`         | `packages/zod/src/v4/core/schemas.ts`, `core.ts`, `json-schema-processors.ts`                                       |

## Addendum: Impact on Implementation Plan

This research supersedes the explicit `<Options, FormatMap>` type parameter approach from the prior plan. The following tasks are affected:

- **Task 3** (per-kernel `*.schemas.ts`): Now also exports `optionsSchema` (Zod) for kernels with options, in addition to `exportSchemas` and `Options` type
- **Task 12** (`createKernelPlugin` restructuring): Uses `optionsSchema`-based inference instead of explicit `Options` + `FormatMap` type parameters. The overloads are simpler (no explicit type params needed)
- **Task 13** (plugin simplification): Plugins import `optionsSchema` and `exportSchemas` from `*.schemas.ts`, pass both to `createKernelPlugin`. No explicit type parameters
- **Task 3 addendum**: Each kernel's existing `optionsSchema` (currently private in `*.kernel.ts`) moves to `*.schemas.ts`. The `Options` type is derived as `z.input<typeof optionsSchema>` rather than being a separate hand-written type
