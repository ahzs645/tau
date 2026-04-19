---
title: 'Type-Safe Kernel IDs'
description: 'Blueprint for achieving compile-time type safety for kernel IDs from plugin declaration through protocol boundary to UI consumption'
status: draft
created: '2026-04-10'
updated: '2026-04-10'
category: architecture
related:
  - docs/research/export-options-kernel-mismatch.md
  - docs/policy/library-api-policy.md
---

# Type-Safe Kernel IDs

Blueprint for propagating kernel ID literal types from plugin factory declarations through the runtime protocol boundary to UI-layer event handlers and export route selection.

## Executive Summary

`@taucad/runtime` already captures export format literals and per-format option types at compile time via `CollectExportFormats` and `CollectFormatMap`. Kernel IDs, however, are declared as `string` in `KernelPlugin.id` and arrive at the UI as opaque `string | undefined` values. Since `kernel-worker.constants.ts` statically declares every kernel and `createRuntimeClient` is the canonical entry point, we have a closed, statically-known set of kernel IDs at the call site. This document blueprints how to lift those literals into the type system using the same phantom-generic pattern already proven for export formats, and identifies the exact files, types, and overloads that require modification.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

Three concrete problems motivate this work:

1. **`activeKernelChanged` event carries `string | undefined`** — the upcoming protocol event (from R1 of `export-options-kernel-mismatch.md`) will expose `kernelId` to the UI, but `string | undefined` offers zero compile-time guarantees.

2. **`ExportRoute.kernelId`, `ExportFormatCapability.kernelId`, and `RenderOptionCapability.kernelId` are `string`** — route selection, capability filtering, and schema resolution operate on bare strings, making typos and stale references invisible.

3. **Two parallel kernel ID registries exist with a mismatch** — `libs/types` declares `KernelId = 'openscad' | 'replicad' | 'manifold' | 'zoo' | 'jscad' | 'opencascadejs'` (derived from `kernelConfigurations`), while runtime plugins use `id: 'opencascade'` (not `'opencascadejs'`). Neither registry is authoritative for the other.

## Methodology

Source analysis across the full type flow:

- Plugin declaration: `createKernelPlugin` overloads, `KernelPlugin<FormatMap>` phantom generic
- Plugin collection: `CollectExportFormats`, `CollectFormatMap`, `UnionToIntersection`
- Client creation: `createRuntimeClient` `const Plugins` overload, `createRuntimeClientOptions` widening
- Protocol boundary: `RuntimeResponse` discriminated union, `postMessage` structured clone
- UI consumption: `cad.machine.ts` context, `chat-converter.tsx` route selection, `useRender` hook

## Findings

### Finding 1: `CollectExportFormats` pattern is directly replicable for kernel IDs

`CollectExportFormats` extracts format string literals from a plugin tuple:

```typescript
type CollectExportFormats<Plugins extends readonly KernelPlugin<any>[]> = Plugins[number] extends {
  exportFormats: ReadonlyArray<infer F>;
}
  ? F
  : string;
```

An identical pattern works for kernel IDs — `Plugins[number] extends { id: infer I } ? I : string` — **but only if `KernelPlugin.id` preserves the literal type**. Today `id: string` widens `'replicad'` to `string`, making `infer I` always resolve to `string`.

### Finding 2: `KernelPlugin.id` is the single widening bottleneck

Every kernel plugin factory passes a string literal to `id`:

| Plugin          | `id` value      |
| --------------- | --------------- |
| `openscad()`    | `'openscad'`    |
| `replicad()`    | `'replicad'`    |
| `manifold()`    | `'manifold'`    |
| `jscad()`       | `'jscad'`       |
| `opencascade()` | `'opencascade'` |
| `zoo()`         | `'zoo'`         |
| `tau()`         | `'tau'`         |

All seven literals are available at the `createKernelPlugin` call site. The `KernelPluginConfig` type inherits `id: string` from `KernelPlugin`, erasing the literal before `createKernelPlugin` returns. This is the sole bottleneck — every downstream consumer inherits the widened `string`.

### Finding 3: Phantom generic is not required — structural inference suffices

`CollectFormatMap` uses a phantom `[__exportSchemas]?: FormatMap` brand because format-to-options mappings have no runtime representation. Kernel IDs, by contrast, already exist as `id: string` on the runtime object. Instead of adding a second phantom brand (`[__kernelId]?: Id`), we can narrow `id` itself from `string` to a generic `Id extends string`:

```typescript
export type KernelPlugin<FormatMap extends Record<string, unknown> = {}, Id extends string = string> = {
  id: Id;
  // ... rest unchanged
};
```

This preserves backward compatibility: `KernelPlugin` (no args) defaults to `id: string`. When `createKernelPlugin` infers `Id` from the config literal, the narrowed type flows through naturally.

### Finding 4: `createKernelPlugin` overloads need an `Id` type parameter

The first overload (static config, no options) currently infers only `ES`:

```typescript
export function createKernelPlugin<ES extends Record<string, z.ZodType> = Record<string, z.ZodType>>(
  config: KernelPluginConfig<ES>,
): () => KernelPlugin<ResolveFormatMap<ES>>;
```

Adding `Id` requires careful placement to avoid the partial-inference limitation documented in `define-plugin.test-d.ts` line 1173. The `Id` parameter must be inferred from the config's `id` field, not specified explicitly.

**Overload 1 (static config):**

```typescript
export function createKernelPlugin<
  Id extends string = string,
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(config: KernelPluginConfig<ES, Id>): () => KernelPlugin<ResolveFormatMap<ES>, Id>;
```

**Overload 2 (config with Options):**

```typescript
export function createKernelPlugin<
  Options extends Record<string, unknown>,
  Id extends string = string,
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(
  config: KernelPluginConfig<ES, Id> | ((options: Options | undefined) => KernelPluginConfig<ES, Id>),
): Partial<Options> extends Options
  ? (options?: Options) => KernelPlugin<ResolveFormatMap<ES>, Id>
  : (options: Options) => KernelPlugin<ResolveFormatMap<ES>, Id>;
```

The `KernelPluginConfig` type must also thread `Id`:

```typescript
type KernelPluginConfig<
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  Id extends string = string,
> = Omit<KernelPlugin<any, Id>, 'options' | 'exportOptionSchemas' | 'renderSchema'> & {
  renderSchema?: z.ZodType;
  exportOptionSchemas?: ES;
};
```

### Finding 5: `const Plugins` in `createRuntimeClient` already preserves tuple inference

The typed overload of `createRuntimeClient`:

```typescript
export function createRuntimeClient<const Plugins extends KernelPlugin<any>[]>(
  options: Omit<RuntimeClientOptions, 'kernels'> & { kernels: [...Plugins] },
): RuntimeClient<CollectFormatMap<Plugins>>;
```

The `const` modifier and tuple spread `[...Plugins]` preserve per-element types. Once `KernelPlugin` carries an `Id` parameter, each element in the tuple retains its literal `Id`. A new `CollectKernelIds` utility type extracts the union:

```typescript
export type CollectKernelIds<Plugins extends readonly KernelPlugin<any, any>[]> =
  Plugins[number] extends KernelPlugin<any, infer I> ? I : string;
```

The client type becomes `RuntimeClient<CollectFormatMap<Plugins>, CollectKernelIds<Plugins>>`.

### Finding 6: `createRuntimeClientOptions` is a widening boundary — by design

`createRuntimeClientOptions` returns `RuntimeClientOptions`, which uses `kernels: KernelPlugin[]`. This intentionally widens the type because:

1. The merge overload combines two `RuntimeClientOptions` — the merged result can have any kernels.
2. The identity overload is a convenience passthrough.

When the UI calls `createRuntimeClientOptions(...)` in `kernel-worker.constants.ts` and then passes the result to `createRuntimeClient`, the `const Plugins` overload on `createRuntimeClient` cannot recover the widened tuple. However, this is solvable in two ways:

**Option A: Parameterize `createRuntimeClientOptions`** — add a `const Plugins` overload that preserves the kernel tuple through the merge. The identity overload would return a type carrying the plugin tuple.

**Option B: Inline kernel array in `createRuntimeClient` call** — the UI's `cad.machine.ts` passes `kernelOptions` to `createRuntimeClient`. If the type of `kernelOptions` preserved the kernel tuple, the client would be fully typed.

Option A is recommended because the `kernel-worker.constants.ts → cad.machine.ts → RuntimeClient` pipeline is the canonical path and all three files are under our control.

### Finding 7: `postMessage` does not erase types — it operates below the type system

A common misconception is that `postMessage` "erases" TypeScript types. In reality, `postMessage` performs structured clone at runtime — TypeScript types are compile-time-only and are never present at runtime. The type annotation on the receiving side (`transport.onMessage((response: RuntimeResponse) => ...)`) is a trust contract.

Since `RuntimeClient<FormatMap, KernelIds>` knows which kernel IDs are registered, it can annotate the `activeKernelChanged` callback with `KernelIds | undefined` instead of `string | undefined`. The runtime value crossing `postMessage` is still a plain string, but the receiving type narrows it. This is identical to how `export<F extends FileExtension & keyof FormatMap>` works today — the actual `format` at runtime is a string, but the type system constrains it.

### Finding 8: Two parallel kernel ID registries exist with a naming mismatch

| Source                                                                | ID for OpenCascade kernel | Contains `tau`? |
| --------------------------------------------------------------------- | ------------------------- | --------------- |
| `libs/types/constants/kernel.constants.ts` (`KernelId`)               | `'opencascadejs'`         | No              |
| `packages/runtime/src/kernels/opencascade/opencascade.plugin.ts`      | `'opencascade'`           | N/A             |
| `packages/runtime/src/types/runtime.types.ts` (`KnownKernelProvider`) | `KernelProvider \| 'tau'` | Yes (union)     |

The `KernelId` type from `libs/types` represents **UI-facing kernel catalog entries** (used for project creation, kernel selector, file icons). The runtime `KernelPlugin.id` represents **engine-level identifiers** (used for kernel selection, export routing, protocol events). These are distinct domains:

- UI: `'opencascadejs'` — the user-facing brand name for "OpenCascade.js"
- Runtime: `'opencascade'` — the engine identifier

This mismatch means `CollectKernelIds` (from runtime plugins) will produce `'replicad' | 'openscad' | 'manifold' | 'jscad' | 'opencascade' | 'zoo' | 'tau'`, which differs from the UI's `KernelId`. **This is expected and correct** — they serve different purposes. The `activeKernelChanged` event should carry the runtime union, not the UI catalog union.

### Finding 9: `RuntimeClient` already has one generic — adding a second is low-friction

`RuntimeClient<FormatMap>` is parameterized with a single generic defaulting to `{}`. Adding `KernelIds` as a second parameter follows the same pattern:

```typescript
export type RuntimeClient<FormatMap extends Record<string, unknown> = {}, KernelIds extends string = string> = {
  // existing members unchanged...
  readonly activeKernelId: KernelIds | undefined;
  on(event: 'activeKernel', handler: (kernelId: KernelIds | undefined) => void): () => void;
  // ... rest unchanged
};
```

All existing consumers that use `RuntimeClient` or `RuntimeClient<SomeMap>` continue to work because `KernelIds` defaults to `string`.

### Finding 10: Downstream UI types benefit from narrowing

With `KernelIds` available on `RuntimeClient`, the following UI-layer types gain compile-time safety:

| Consumer                                         | Current type          | Narrowed type                               |
| ------------------------------------------------ | --------------------- | ------------------------------------------- |
| `cad.machine.ts` `CadContext.activeKernelId`     | `string \| undefined` | `KernelIds \| undefined`                    |
| `selectBestRoutes` `activeKernelId` param        | `string \| undefined` | `KernelIds \| undefined`                    |
| `ExportRoute.kernelId` filtering                 | `=== string`          | `=== KernelIds`                             |
| `CapabilitiesManifest.kernelExports[n].kernelId` | `string`              | Remains `string` (manifest is worker-built) |

The manifest types (`ExportRoute`, `ExportFormatCapability`, `RenderOptionCapability`) remain `kernelId: string` because they are constructed worker-side from runtime data — narrowing them would require parameterizing `CapabilitiesManifest`, which adds complexity without proportional benefit. The comparison `route.kernelId === activeKernelId` is already safe when `activeKernelId` is narrowed — TypeScript permits `string === literal`.

## Recommendations

| #   | Action                                                                               | Priority | Effort | Impact                                   |
| --- | ------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------- |
| R1  | Add `Id extends string = string` generic to `KernelPlugin`                           | P0       | Low    | Foundation for all downstream narrowing  |
| R2  | Thread `Id` through `KernelPluginConfig` and `createKernelPlugin` overloads          | P0       | Medium | Captures literal from plugin factories   |
| R3  | Add `CollectKernelIds<Plugins>` utility type to `plugin-types.ts`                    | P0       | Low    | Mirrors `CollectExportFormats` pattern   |
| R4  | Add `KernelIds` generic to `RuntimeClient` + `createRuntimeClient` overload          | P0       | Medium | Exposes narrowed kernel IDs to consumers |
| R5  | Parameterize `createRuntimeClientOptions` identity overload to preserve kernel tuple | P1       | Medium | Prevents widening in the canonical path  |
| R6  | Type `activeKernelId` getter and `on('activeKernel')` with `KernelIds`               | P1       | Low    | Narrowed events in UI layer              |
| R7  | Add type-level tests in `define-plugin.test-d.ts` for `CollectKernelIds`             | P0       | Low    | Validates inference chain                |
| R8  | Thread `KernelIds` through `CadContext` in `cad.machine.ts`                          | P2       | Low    | Full end-to-end type safety              |
| R9  | Document `KernelId` (libs/types) vs `CollectKernelIds` (runtime) distinction         | P2       | Low    | Prevents future confusion                |

## Trade-offs

### Alternative A: Phantom brand `[__kernelId]?: Id` instead of narrowing `id` field

| Dimension         | Structural `id: Id` (recommended)            | Phantom brand                         |
| ----------------- | -------------------------------------------- | ------------------------------------- |
| Backward compat   | Fully compatible (default `string`)          | Fully compatible (optional phantom)   |
| Runtime presence  | `id` already exists at runtime               | Phantom has no runtime representation |
| Inference quality | TypeScript infers from config object literal | Requires explicit brand assignment    |
| Readability       | `plugin.id` type is visibly narrow           | Hidden behind symbol                  |
| Consistency       | Breaks pattern with `FormatMap` (phantom)    | Consistent with `FormatMap`           |

**Verdict:** Structural narrowing is preferred. Unlike `FormatMap` (which has no runtime field), `id` is a real runtime field. Using a phantom brand to shadow a field that already exists is unnecessarily indirect.

### Alternative B: Union type alias instead of generic inference

Define a hardcoded union `type RuntimeKernelId = 'replicad' | 'openscad' | ...` and use it for `KernelPlugin.id`.

| Dimension            | Generic inference (recommended)              | Hardcoded union                        |
| -------------------- | -------------------------------------------- | -------------------------------------- |
| Extensibility        | Third-party plugins "just work"              | Must update union for every new kernel |
| DRY                  | Single source of truth (config literal)      | Duplicated in alias + config           |
| Consumer flexibility | `RuntimeClient<FM, MyIds>` allows subsetting | Global union or nothing                |

**Verdict: Rejected.** A hardcoded union violates the library-api-policy principle that third-party consumers should be able to extend the system without modifying library types.

### Alternative C: Skip `createRuntimeClientOptions` parameterization (R5)

Accept the widening from `createRuntimeClientOptions` and require consumers to cast or restructure.

| Dimension       | Parameterize (recommended)    | Skip                                             |
| --------------- | ----------------------------- | ------------------------------------------------ |
| DX at call site | Fully inferred                | Requires manual type annotation or restructuring |
| Complexity      | One additional overload       | None                                             |
| Risk            | Overload inference edge cases | None                                             |

**Verdict:** R5 is P1, not P0. The system works with `string` fallback when using `createRuntimeClientOptions`. The `createRuntimeClient` overload recovers types when kernels are passed inline. Defer R5 if overload complexity is a concern.

## Code Examples

### R1–R2: `KernelPlugin` and `createKernelPlugin` changes

```typescript
// plugin-types.ts
export type KernelPlugin<FormatMap extends Record<string, unknown> = {}, Id extends string = string> = {
  id: Id;
  moduleUrl: string;
  extensions: string[];
  // ... rest unchanged
  readonly [__exportSchemas]?: FormatMap;
};

// plugin-helpers.ts — overload 1 (static config)
export function createKernelPlugin<
  Id extends string = string,
  ES extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(config: KernelPluginConfig<ES, Id>): () => KernelPlugin<ResolveFormatMap<ES>, Id>;
```

After this change, `replicad()` returns `KernelPlugin<{ stl: ...; step: ...; glb: ... }, 'replicad'>` — the `'replicad'` literal is preserved.

### R3: `CollectKernelIds`

```typescript
// plugin-types.ts
export type CollectKernelIds<Plugins extends readonly KernelPlugin<any, any>[]> =
  Plugins[number] extends KernelPlugin<any, infer I> ? I : string;
```

Usage mirrors `CollectExportFormats`:

```typescript
type Ids = CollectKernelIds<[KernelPlugin<{}, 'replicad'>, KernelPlugin<{}, 'openscad'>]>;
// 'replicad' | 'openscad'
```

### R4: `RuntimeClient` and `createRuntimeClient`

```typescript
// runtime-client.ts
export type RuntimeClient<FormatMap extends Record<string, unknown> = {}, KernelIds extends string = string> = {
  readonly activeKernelId: KernelIds | undefined;
  on(event: 'activeKernel', handler: (kernelId: KernelIds | undefined) => void): () => void;
  // ... existing overloads unchanged
};

export function createRuntimeClient<const Plugins extends KernelPlugin<any, any>[]>(
  options: Omit<RuntimeClientOptions, 'kernels'> & { kernels: [...Plugins] },
): RuntimeClient<CollectFormatMap<Plugins>, CollectKernelIds<Plugins>>;
```

### R5: `createRuntimeClientOptions` identity overload

```typescript
// runtime-client-options.ts
export function createRuntimeClientOptions<const Plugins extends KernelPlugin<any, any>[]>(
  options: Omit<RuntimeClientOptions, 'kernels'> & { kernels: [...Plugins] },
): Omit<RuntimeClientOptions, 'kernels'> & { kernels: [...Plugins] };
```

This preserves the kernel tuple through the convenience helper. The merge overload continues to return `RuntimeClientOptions` (widened), since merged results have indeterminate plugin composition.

### R7: Type-level tests

```typescript
// define-plugin.test-d.ts
describe('CollectKernelIds type inference', () => {
  it('should collect kernel ID literals from plugin tuple', () => {
    type PluginA = KernelPlugin<{}, 'replicad'>;
    type PluginB = KernelPlugin<{}, 'openscad'>;

    type Ids = CollectKernelIds<[PluginA, PluginB]>;
    expectTypeOf<Ids>().toEqualTypeOf<'replicad' | 'openscad'>();
  });

  it('should deduplicate overlapping kernel IDs', () => {
    type PluginA = KernelPlugin<{}, 'replicad'>;
    type PluginB = KernelPlugin<{}, 'replicad'>;

    type Ids = CollectKernelIds<[PluginA, PluginB]>;
    expectTypeOf<Ids>().toEqualTypeOf<'replicad'>();
  });

  it('should fall back to string when Id is not narrowed', () => {
    type Ids = CollectKernelIds<[KernelPlugin]>;
    expectTypeOf<Ids>().toEqualTypeOf<string>();
  });

  it('should infer kernel ID from createKernelPlugin factory', () => {
    const factory = createKernelPlugin({
      id: 'test-kernel',
      moduleUrl: 'test.js',
      extensions: ['ts'],
    });
    const plugin = factory();
    expectTypeOf(plugin.id).toEqualTypeOf<'test-kernel'>();
  });

  it('should preserve kernel IDs through createRuntimeClient', () => {
    const replicadPlugin = createKernelPlugin({
      id: 'replicad',
      moduleUrl: 'replicad.js',
      extensions: ['ts'],
    });
    const openscadPlugin = createKernelPlugin({
      id: 'openscad',
      moduleUrl: 'openscad.js',
      extensions: ['scad'],
    });

    const client = createRuntimeClient({
      kernels: [replicadPlugin(), openscadPlugin()],
    });

    expectTypeOf(client.activeKernelId).toEqualTypeOf<'replicad' | 'openscad' | undefined>();
  });
});
```

## Diagrams

### Type flow: plugin declaration → UI event handler

```
createKernelPlugin({ id: 'replicad', ... })
  │
  ├─ KernelPluginConfig<ES, 'replicad'>
  │   └─ id: 'replicad' (literal preserved via Id generic)
  │
  └─ returns () => KernelPlugin<FormatMap, 'replicad'>
                          │
createRuntimeClient({ kernels: [replicad(), openscad()] })
  │
  ├─ const Plugins = [KernelPlugin<FM1, 'replicad'>, KernelPlugin<FM2, 'openscad'>]
  │
  ├─ CollectKernelIds<Plugins> = 'replicad' | 'openscad'
  ├─ CollectFormatMap<Plugins>  = { stl: ..., step: ..., ... }
  │
  └─ RuntimeClient<FormatMap, 'replicad' | 'openscad'>
       │
       ├─ .activeKernelId: 'replicad' | 'openscad' | undefined
       │
       ├─ .on('activeKernel', (id: 'replicad' | 'openscad' | undefined) => ...)
       │            │
       │     ┌──────┘  (postMessage boundary — runtime string, typed annotation)
       │     │
       └─ worker: activeKernelId = 'replicad'  ──postMessage──►  callback(id)
```

### Widening boundaries

```
  createRuntimeClientOptions({ kernels: [...] })
        │
        ▼ returns RuntimeClientOptions (kernels: KernelPlugin[])
        │                          ▲
        │                          │ WIDENING POINT
        │                          │
  ┌─────┴─────────────────────────┐
  │  Option A (R5):               │
  │  Identity overload preserves  │
  │  kernel tuple via const       │
  │  generic → no widening        │
  └───────────────────────────────┘
        │
        ▼
  createRuntimeClient(options)
        │
        ├─ If options.kernels is KernelPlugin[] → fallback overload → RuntimeClient<{}>
        │
        └─ If options.kernels is [...Plugins]   → typed overload   → RuntimeClient<FM, Ids>
```

## Implementation Order

Recommended dependency-ordered implementation:

1. **R1 + R2**: `KernelPlugin<FM, Id>` + `createKernelPlugin` overloads (foundation)
2. **R3**: `CollectKernelIds` utility type
3. **R7**: Type-level tests validating R1–R3
4. **R4**: `RuntimeClient<FM, Ids>` + `createRuntimeClient` overload
5. **R6**: `activeKernelId` getter + `on('activeKernel')` typing
6. **R5**: `createRuntimeClientOptions` identity overload (optional, P1)
7. **R8**: Thread `KernelIds` through `CadContext` (optional, P2)
8. **R9**: Documentation of `KernelId` vs `CollectKernelIds` distinction

### Files affected

| File                                                    | Changes                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/plugins/plugin-types.ts`          | R1: Add `Id` generic to `KernelPlugin`; R3: Add `CollectKernelIds`                                            |
| `packages/runtime/src/plugins/plugin-helpers.ts`        | R2: Thread `Id` through `KernelPluginConfig` and overloads                                                    |
| `packages/runtime/src/client/runtime-client.ts`         | R4: Add `KernelIds` generic to `RuntimeClient` and `createRuntimeClient`; R6: Type `activeKernelId` and event |
| `packages/runtime/src/client/runtime-client-options.ts` | R5: Add identity overload preserving kernel tuple                                                             |
| `packages/runtime/src/plugins/presets.ts`               | No change — presets intentionally widen                                                                       |
| `packages/runtime/src/types/runtime.types.ts`           | No change — manifest types stay `kernelId: string`                                                            |
| `packages/runtime/src/types/runtime-protocol.types.ts`  | No change — protocol carries `string`, typed at receive                                                       |
| `packages/runtime/src/types/define-plugin.test-d.ts`    | R7: Add `CollectKernelIds` test suite                                                                         |
| `apps/ui/app/machines/cad.machine.ts`                   | R8: Type `activeKernelId` with client's `KernelIds`                                                           |
| `apps/ui/app/routes/projects_.$id/chat-converter.tsx`   | R8: `selectBestRoutes` param typed via client                                                                 |

### Risk assessment

| Risk                                                                                                | Likelihood | Mitigation                                                               |
| --------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `createKernelPlugin` explicit `Options` generic kills `Id` inference (partial-inference limitation) | Medium     | Place `Id` before `ES` in type param list; validate with type-level test |
| `createRuntimeClientOptions` merge overload loses `Id`                                              | Expected   | Merge always widens — document as intentional                            |
| Third-party plugins without `Id` get `string` fallback                                              | Expected   | Default `Id = string` ensures backward compat                            |
| `config-as-function` builder doesn't infer `Id` from return type                                    | Low        | TypeScript infers from object literal in return position; test confirms  |

## References

- Related: `docs/research/export-options-kernel-mismatch.md` — R1 `activeKernelChanged` event motivating kernel ID typing
- Related: `docs/policy/library-api-policy.md` — third-party extensibility requirement
- `packages/runtime/src/types/define-plugin.test-d.ts` lines 1173–1186 — documented partial-inference limitation
- `libs/types/src/constants/kernel.constants.ts` — UI-facing `KernelId` union (distinct from runtime IDs)
