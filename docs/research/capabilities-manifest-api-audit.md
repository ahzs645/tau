---
title: 'CapabilitiesManifest API Audit'
description: 'Critical audit of the CapabilitiesManifest API surface against actual consumer usage and Library API Policy compliance, identifying surplus fields, redundant data, naming inconsistencies, and missing type linkages'
status: draft
created: '2026-04-10'
updated: '2026-04-10'
category: audit
related:
  - docs/policy/library-api-policy.md
  - docs/research/lazy-capabilities-manifest.md
  - docs/research/runtime-client-type-safety-audit.md
  - docs/research/transcoder-edge-source-type-merging.md
  - docs/research/export-pipeline-v5.md
---

# CapabilitiesManifest API Audit

Critical audit of the `CapabilitiesManifest` public API in `@taucad/runtime`, evaluating consumer usage, data redundancy, naming consistency, and conformance with the Library API Policy.

## Executive Summary

`CapabilitiesManifest` is a `@public` API on `@taucad/runtime` that ships four parallel data structures — `kernelExports`, `transcodeEdges`, `exportRoutes`, `renderOptions`. The audit shows that **only `exportRoutes` is consumed externally**: every UI consumer reads from `exportRoutes` and ignores the other three fields. `kernelExports` and `transcodeEdges` are surplus precursors whose information is fully reachable through `exportRoutes`. `renderOptions` is unread by every external consumer. Additionally, the manifest carries a `routeId` field that is never used as a key, suffers cross-product schema duplication (the same JSON Schema is serialized up to three times per format), uses inconsistent naming conventions across its members, exposes `Record<string, unknown>` for shapes that should be `JSONSchema7`, and provides no helper API for the route-selection logic that every consumer reimplements. The package has not been released, so the recommendation is to roll directly to the target shape: a single `routes` source-of-truth, an indexed `renderSchemas` map, branded ID types, properly typed JSON Schemas, and a helper API on `RuntimeClient` that encapsulates route selection.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Manifest Inventory](#manifest-inventory)
- [Consumer Inventory](#consumer-inventory)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

The `CapabilitiesManifest` was added to support the v5 Export Pipeline and the lazy-load architecture from the [Lazy Capabilities Manifest](lazy-capabilities-manifest.md) research. It is now part of the public surface of `@taucad/runtime`:

- Returned synchronously from `client.capabilities`
- Pushed via `client.on('capabilities', handler)` after each kernel load
- Carried on the `'initialized'` and `'capabilitiesUpdated'` protocol responses
- Annotated `@public` in JSDoc on every member type (`ExportFormatCapability`, `TranscodeEdgeCapability`, `ExportRoute`, `RenderOptionCapability`, `CapabilitiesManifest`)

The manifest will become a load-bearing contract for third-party consumers of the runtime client (CLI, server-side renderers, alternative UIs). The package is unreleased, so this is the right moment to roll directly to the desired shape without compatibility constraints. This audit answers four questions:

1. **Are any properties surplus to requirement today?**
2. **Are all properties actually consumed by anyone?**
3. **Does the design comply with `docs/policy/library-api-policy.md`?**
4. **What is the architecturally correct end-state shape for third-party consumers?**

## Methodology

1. Read the canonical type definition in `packages/runtime/src/types/runtime.types.ts` (lines 266–340) and protocol carrier in `runtime-protocol.types.ts`
2. Traced manifest construction in `KernelWorker.buildCapabilitiesManifest()` (kernel-worker.ts lines 1946–2043)
3. Traced manifest delivery: `KernelRuntimeWorker.loadKernelModule` → `runtime-worker-dispatcher` → `RuntimeWorkerClient.handleMessage('capabilitiesUpdated')` → `RuntimeClient` event emitter → consumers
4. Grep audit of every read site for each manifest field across `apps/`, `packages/`, `libs/`
5. Cross-referenced each field with the 19 numbered rules in `docs/policy/library-api-policy.md`
6. Reviewed adjacent research (`lazy-capabilities-manifest.md`, `runtime-client-type-safety-audit.md`, `transcoder-edge-source-type-merging.md`) for in-flight work that may obsolete or constrain recommendations

## Manifest Inventory

The full type surface exposed via `@public`:

| Type                      | Members                                                                                                  | `@public` |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| `CapabilitiesManifest`    | `kernelExports`, `transcodeEdges`, `exportRoutes`, `renderOptions?`                                      | yes       |
| `ExportFormatCapability`  | `kernelId`, `format`, `fidelity`, `schema`, `defaults`                                                   | yes       |
| `TranscodeEdgeCapability` | `transcoderId`, `from`, `to`, `fidelity`, `schema`, `defaults`                                           | yes       |
| `ExportRoute`             | `routeId`, `targetFormat`, `kernelId`, `sourceFormat`, `transcoderId?`, `fidelity`, `schema`, `defaults` | yes       |
| `RenderOptionCapability`  | `kernelId`, `schema`, `defaults`                                                                         | yes       |
| `ExportFidelity`          | `'brep' \| 'mesh'`                                                                                       | yes       |

Total surface: 5 types, 27 properties (some duplicated semantically across types).

## Consumer Inventory

Result of `rg "capabilities\.(kernelExports|transcodeEdges|exportRoutes|renderOptions)"` across the entire workspace, excluding test files and research docs:

| Field            | External consumers (UI/React/SDK)       | Internal consumers (worker)                                 | Test-only references |
| ---------------- | --------------------------------------- | ----------------------------------------------------------- | -------------------- |
| `kernelExports`  | **none**                                | none                                                        | 7 sites              |
| `transcodeEdges` | **none**                                | none                                                        | 5 sites              |
| `exportRoutes`   | `chat-converter.tsx`, `hero-viewer.tsx` | `executeExportWithRoute`, `exportGeometry` (worker-only)    | 17 sites             |
| `renderOptions`  | **none**                                | none (validation reads `kernelRenderZodSchemaMap` directly) | 2 sites              |

Cross-referenced field-level reads:

| Member field                | External consumers                                          | Internal consumers                     |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `ExportRoute.routeId`       | none                                                        | none (only emitted)                    |
| `ExportRoute.targetFormat`  | both UI consumers                                           | route filter                           |
| `ExportRoute.kernelId`      | both UI consumers                                           | route filter                           |
| `ExportRoute.sourceFormat`  | none                                                        | source-options re-validation in worker |
| `ExportRoute.transcoderId`  | UI checks `!route.transcoderId` for direct/transcoded label | worker dispatch lookup                 |
| `ExportRoute.fidelity`      | `chat-converter` (best-route tiebreak)                      | none                                   |
| `ExportRoute.schema`        | both UI consumers (RJSF form)                               | none                                   |
| `ExportRoute.defaults`      | `chat-converter` (form defaults + delta)                    | none                                   |
| `ExportFormatCapability.*`  | none                                                        | tests only                             |
| `TranscodeEdgeCapability.*` | none                                                        | tests only                             |
| `RenderOptionCapability.*`  | none                                                        | none                                   |

## Findings

### Finding 1: `kernelExports` is a vestigial precursor — entirely redundant with `exportRoutes`

Every `kernelExports[i]` corresponds 1:1 to an `exportRoutes` entry where `transcoderId === undefined`:

```typescript
// kernel-worker.ts:2001 — direct routes are a verbatim copy of kernelExports
for (const cap of kernelExports) {
  exportRoutes.push({
    routeId: `direct-${routeIndex++}`,
    targetFormat: cap.format,
    kernelId: cap.kernelId,
    sourceFormat: cap.format,
    fidelity: cap.fidelity,
    schema: cap.schema, // <-- same object reference as cap.schema
    defaults: cap.defaults, // <-- same object reference as cap.defaults
  });
}
```

The transformation is mechanical and lossless. A consumer that wants the kernel-direct view simply filters `exportRoutes.filter((r) => !r.transcoderId)`. No external consumer reads `kernelExports`; only worker tests assert on it (and only because the field exists). **Cost of keeping the field**: ~3 KB of duplicated wire payload per push, an extra serialization pass, and a maintenance burden when the schema changes.

### Finding 2: `transcodeEdges` is a vestigial precursor — entirely reachable from `exportRoutes`

For each declared edge, the manifest creates one `exportRoutes` entry per matching kernel source format:

```typescript
// kernel-worker.ts:2013
for (const edge of resolvedEdges) {
  for (const cap of kernelExports) {
    if (cap.format === edge.from) {
      exportRoutes.push({
        /* ... transcoderId, sourceFormat, fidelity, merged schema ... */
      });
    }
  }
}
```

A consumer that wants "all transcode edges declared by all transcoders" can derive it via:

```typescript
const edges = new Map<string, TranscodeEdgeCapability>();
for (const r of capabilities.exportRoutes) {
  if (r.transcoderId) {
    const key = `${r.transcoderId}:${r.sourceFormat}:${r.targetFormat}`;
    if (!edges.has(key)) edges.set(key /* synthesize */);
  }
}
```

But no consumer wants this view — they all want "what can the active kernel export, possibly via transcoders?" which is precisely `exportRoutes`. `transcodeEdges` exists only as a debugging aid and bloats the wire payload.

### Finding 3: `renderOptions` is read by zero external consumers

Grep confirms: no production code outside `KernelWorker` itself reads `capabilities.renderOptions`. It is referenced in two test sites that assert it exists. The render-option JSON Schema is needed by the UI to render render-option forms, but **no UI yet renders such a form** — the `chat-parameters` panel renders the `getParameters` schema (which is per-file user parameters), not the render-option schema (which is per-kernel framework options like `tessellation`).

When/if a render-option form is added (per [Runtime Client Type Safety Audit R3](runtime-client-type-safety-audit.md)), the data should be discoverable. The current shape (an array of `{ kernelId, schema, defaults }` records) does not match the natural access pattern, which is "give me the render-option schema for kernel X". Recommendation R6 reshapes this into an indexed map.

### Finding 4: `routeId` is never used as a key

`routeId` is generated as `direct-0`, `direct-1`, `transcode-0`, etc. and serialized on every route. No consumer:

- Looks up a route by ID
- Stores route IDs across renders
- Uses route IDs in URLs, persisted preferences, or telemetry

Tests assert mock `routeId` values for round-trip checks, but no production code reads the field. The field exists because the v5 spec mentioned propagating route metadata onto export responses ([Export Pipeline Gap Analysis F4](export-pipeline-gap-analysis.md)), but that propagation was never implemented. The field is dead weight.

### Finding 5: `schema` and `defaults` are duplicated up to three times per format

For a format with one transcoder route and one direct route, the same JSON Schema is serialized at three sites:

| Location                           | What it contains                    |
| ---------------------------------- | ----------------------------------- |
| `kernelExports[i].schema`          | Kernel's GLB schema                 |
| `transcodeEdges[j].schema`         | Transcoder's edge schema (separate) |
| `exportRoutes[direct-N].schema`    | Same as `kernelExports[i].schema`   |
| `exportRoutes[transcode-N].schema` | Merged kernel + transcoder schema   |

A consumer that follows the [Lazy Capabilities Manifest](lazy-capabilities-manifest.md) recommendation (manifest pushed on every kernel load) receives this duplicated payload many times during startup. For a typical preset: ~17 kernel exports × ~500 bytes + ~10 edges × ~300 bytes + ~25 routes × ~700 bytes ≈ 30 KB per push. Three pushes per kernel = ~90 KB. Collapsing to `exportRoutes` only would cut wire payload by ~40%.

### Finding 6: `fidelity` derivation is hardcoded in the worker

```typescript
// kernel-worker.ts:1961
const fidelity: ExportFidelity = format === 'step' || format === 'iges' ? 'brep' : 'mesh';
```

The fidelity assignment for kernel exports is a static lookup based on file extension, not declared by the kernel. This couples the framework to a closed set of brep formats and is impossible to extend without modifying core code. A kernel that adds a new brep format (e.g. `.brep`, `.x_t`) cannot declare it correctly. The fidelity should be declared on the kernel's `exportSchemas` entry (or derived from a well-known constant in `@taucad/types`).

For transcoder edges, `fidelity` is correctly declared by the transcoder via `TranscoderEdge.fidelity`. The asymmetry suggests the kernel side is incomplete.

### Finding 7: `schema: Record<string, unknown>` loses type precision

JSON Schema has a well-known TypeScript shape (`JSONSchema7` from `@types/json-schema`, or `RJSFSchema` in the UI package). Consumers immediately cast:

```typescript
// chat-converter.tsx:208
return { schema: route.schema as RJSFSchema, defaults: route.defaults };
```

Every external consumer is forced to cast. Library API Policy §12 (TypeScript-First Design) directs comprehensive typing for public surfaces. `Record<string, unknown>` here is structural escape-hatch, not intentional flexibility — the worker writes typed JSON Schema and the consumer reads typed JSON Schema with a forced cast in the middle.

### Finding 8: Naming is inconsistent across manifest members

Library API Policy §5 (Naming Conventions) requires consistent naming and forbids term overloading. The current naming has three problems:

| Member           | Naming pattern                | Issue                                                                 |
| ---------------- | ----------------------------- | --------------------------------------------------------------------- |
| `kernelExports`  | `<actor><action>s`            | Reads as "the kernel performs exports"                                |
| `transcodeEdges` | `<action>s<noun>` (irregular) | Reads as "edges of the transcode action"; should be `transcoderEdges` |
| `exportRoutes`   | `<noun>s<noun>`               | Reads as "routes for exporting"                                       |
| `renderOptions`  | `<action><noun>s`             | Reads as "options for rendering"                                      |

`*Capability` suffix is overloaded: `ExportFormatCapability` (a kernel can export `format X`), `TranscodeEdgeCapability` (a transcoder declares edge `X→Y`), `RenderOptionCapability` (a kernel accepts render options). Three distinct concepts share a generic suffix. Per Library API Policy §5: "Avoid overloading terms. If a word is already used for one concept, don't reuse it for another."

Also, `RenderOptionCapability` violates §5 ("Describe the concept, not the container") — the type _is_ the kernel's render-option metadata; it isn't a "capability" in the same sense as "this kernel can export this format". A `KernelRenderOptions` or `RenderOptionDescriptor` would be more precise.

### Finding 9: `kernelId: string` does not use the canonical `KernelProviderId` brand type

`@taucad/runtime` exports `KernelProviderId` (`runtime.types.ts:136`) with documented intellisense for first-party kernels and acceptance of arbitrary third-party IDs. The manifest uses bare `string` for `kernelId` on every member type, breaking the brand-type chain. Consumers comparing `route.kernelId === 'replicad'` get no compiler help. Consistent use of `KernelProviderId` would deliver autocomplete in switch statements and conditional logic.

### Finding 10: Optional `renderOptions` field violates Library API Policy §11

```typescript
export type CapabilitiesManifest = {
  kernelExports: ExportFormatCapability[];
  transcodeEdges: TranscodeEdgeCapability[];
  exportRoutes: ExportRoute[];
  renderOptions?: RenderOptionCapability[]; // <-- optional
};
```

Library API Policy §11 (No Optional Interface Methods) extends to optional data fields when the empty case is meaningful and stable. The worker emits the field only when at least one kernel declares a render schema:

```typescript
// kernel-worker.ts:2041
...(renderOptions.length > 0 ? { renderOptions } : {}),
```

This forces every consumer to write `capabilities.renderOptions ?? []` instead of `capabilities.renderOptions`. The `[]` empty case is semantically valid ("no kernel has render options") and should be emitted.

The same critique applies to `kernelExports`/`transcodeEdges`/`exportRoutes` if the field-collapse recommendation is adopted — empty arrays are the correct representation of "no entries", and absence-vs-empty ambiguity is a foot-gun.

### Finding 11: Wire format does not match consumer access patterns

Both UI consumers iterate `exportRoutes` and filter by `targetFormat` and `kernelId`. The access pattern is:

```typescript
// chat-converter.tsx:135
for (const route of capabilities.exportRoutes) {
  if (route.kernelId !== activeKernelId) continue;
  // ... pick best route per targetFormat
}
```

This is `O(routes)` per format query and requires reimplementing tiebreak logic at each consumer. An indexed shape like `Record<FileExtension, ExportRoute[]>` (or `Map<FileExtension, ExportRoute[]>` in memory) would match the access pattern. Library API Policy §3 (Flat Options with Sensible Defaults) and §10 (High-Level Wrappers with Low-Level Escape Hatches) both suggest exposing the indexed access shape directly, and reserving the flat array for advanced consumers.

### Finding 12: Route-selection logic is reimplemented at every consumer

`chat-converter.tsx` and `hero-viewer.tsx` both implement a "best route per format" selection with their own tiebreak rules:

| Consumer             | Tiebreak rule                                                          |
| -------------------- | ---------------------------------------------------------------------- |
| `chat-converter.tsx` | Filter by activeKernelId → `brep > mesh` → direct > transcoded → first |
| `hero-viewer.tsx`    | Skip kernel filter → first-occurrence wins                             |

Two reimplementations means a third-party consumer will write a third one (or worse, a fourth by guessing). Library API Policy §10 (High-Level Wrappers with Low-Level Escape Hatches) directs the framework to expose the high-level "select the best route for `format X`" helper and reserve the raw array for power users. There is no helper today.

### Finding 13: Manifest delivery uses full-replacement, no diff information

Every `'capabilitiesUpdated'` push contains the complete manifest. The lazy-load model means this fires once per kernel load (~5 times during a typical session for `presets.all()`). For a third-party consumer with a deep equality React selector (`useSelector(state, eq.deep)`), every push is treated as a real change because the route arrays are freshly allocated and `defaults` objects are re-derived from Zod each time.

A push that carried `{ added: ExportRoute[]; removed: routeId[]; replaced: ExportRoute[] }` would let consumers do reference-stable updates. That redesign is non-trivial but the missing diff information is structurally relevant for a `@public` API that fires repeatedly.

### Finding 14: No type-level link between `CapabilitiesManifest` and `client.export()` typing

The runtime manifest contains JSON Schema for every export route. The compile-time `ExportMap` (from `CollectFormatMap` + `MergeExportMap`) contains TypeScript types for the same routes. These two are derived from the same Zod schemas in the kernel definition, but **the type system does not connect the manifest back to the typed `client.export(format, options)` signature**. A consumer holding a `route: ExportRoute` cannot ask the type system "what is the typed options shape for this route?". The `schema` field is `Record<string, unknown>` and `defaults` is `Record<string, unknown>` at the type level.

This is a missed opportunity rather than a regression — the type-safety pipeline (per [Runtime Client Type Safety Audit](runtime-client-type-safety-audit.md)) was a separate workstream that did not surface its types onto the manifest.

### Finding 15: `CapabilitiesManifest` has no `createXOptions` companion

Library API Policy §16 (Type-Safe Options Helpers) requires every options type that consumers may declare standalone to have a `createXOptions` helper. The manifest is a **read-only data structure**, so this rule does not strictly apply — but tests, fixtures, and mock harnesses would benefit from a `createCapabilitiesManifest()` helper that fills in defaults. Currently, every test mock manually constructs the full structure (`chat-converter.test.tsx` has 17 manual mock objects of varying shape), which is brittle.

### Finding 16: No subscribe-anytime guarantee for capabilities events

Library API Policy §7 (Subscribe-Anytime Events) requires `.on(event, handler)` to deliver state correctly regardless of subscription timing. `client.on('capabilities', handler)` works for future updates, but a late-subscribing consumer (e.g., a React component that mounts after `connect()` resolved) misses the initial manifest push. The current pattern works because the consumer can call `client.capabilities` to get the current state, but this is two API calls and an awkward sequencing concern.

A cleaner pattern matches `client.on('capabilities', handler)` with **immediate emission of the current value to the new subscriber** (the React Query/SWR pattern). This is a one-line change in `RuntimeClient.on()` for the `'capabilities'` event.

### Finding 17: `CapabilitiesManifest` is not surfaced via subpath export

Library API Policy §6 (Subpath Exports) recommends organizing exports by audience. Today, `CapabilitiesManifest` and its member types live at the root barrel `@taucad/runtime`. There is no `@taucad/runtime/capabilities` subpath even though the types are a coherent advanced-consumer surface (analytics, telemetry, custom UIs). The current placement is acceptable but worth reviewing if Recommendation R1 lands.

## Recommendations

The package is unreleased, so all recommendations target the desired end state directly. There is no need for `unstable_` gating, deprecation paths, or staged rollouts — every change can land as a single forward-rolled redesign.

| #   | Action                                                                                                                                                                                                                                                                           | Priority | Effort  | Impact                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Collapse to `routes` only**: remove `kernelExports`, `transcodeEdges`, and the standalone `renderOptions` field. The single `routes` array becomes source of truth                                                                                                             | P0       | Medium  | Removes ~40% wire payload, eliminates redundant data, simplifies API surface from 5 types to 2                            |
| R2  | **Drop `routeId` from `ExportRoute`**: never used as a key by any consumer; remove from both type and worker emission                                                                                                                                                            | P0       | Trivial | Removes dead field from the public surface                                                                                |
| R3  | **Type `schema` as `JSONSchema7`** (or re-export the project's chosen JSON Schema type) instead of `Record<string, unknown>`; eliminates forced casts at every consumer                                                                                                          | P1       | Low     | Restores TypeScript-First (§12) compliance; removes 4+ cast sites across codebase                                         |
| R4  | **Use `KernelProviderId`** for every `kernelId` field on the manifest                                                                                                                                                                                                            | P1       | Trivial | Restores brand-type chain; delivers autocomplete in switch statements                                                     |
| R5  | **Make every manifest field required** with empty array/object as the no-data signal                                                                                                                                                                                             | P1       | Trivial | Eliminates absence-vs-empty foot-gun (§11)                                                                                |
| R6  | **Reshape render-option metadata** as `renderSchemas: Partial<Record<KernelProviderId, KernelRenderSchema>>` (indexed by kernel) and emit it eagerly                                                                                                                             | P1       | Low     | Indexed shape matches access pattern; required-field guarantees eliminate optional-chaining at consumers                  |
| R7  | **Lift fidelity onto the kernel `exportSchemas` declaration** rather than hardcoding `step`/`iges` in the worker                                                                                                                                                                 | P1       | Medium  | Removes closed-set assumption (F6); future kernels can declare brep formats correctly                                     |
| R8  | **Add `client.routesFor(format)` and `client.bestRouteFor(format, kernelId?)` helpers** that encapsulate the tiebreak logic both UI consumers reimplement                                                                                                                        | P1       | Low     | Library API Policy §10 — removes ~40 lines of duplicated logic across two UI files; makes the framework's intent explicit |
| R9  | **Make `client.on('capabilities', handler)` emit the current manifest immediately on subscribe** (after first init has resolved)                                                                                                                                                 | P1       | Trivial | Restores subscribe-anytime semantics (§7); removes awkward two-call subscribe pattern                                     |
| R10 | **Rename member types** to remove the overloaded `*Capability` suffix and clarify intent: `ExportFormatCapability` → `KernelExportFormat`; `TranscodeEdgeCapability` → `TranscoderEdge` (collide-rename existing internal type); `RenderOptionCapability` → `KernelRenderSchema` | P2       | Low     | Removes term-overloading violation (§5)                                                                                   |
| R11 | **Surface the manifest via a `@taucad/runtime/capability` subpath export** alongside the route helpers from R8                                                                                                                                                                   | P2       | Low     | Aligns with Library API Policy §6; gives advanced-consumer surface its own audience-scoped barrel                         |
| R12 | **Adopt a manifest-delta protocol** for `'capabilitiesUpdated'` (`added` / `removed` / `replaced`) so reference-stable React selectors do not invalidate on every kernel load                                                                                                    | P3       | High    | Architecturally cleaner; defer until measurable consumer pain shows up                                                    |

### Suggested implementation order

The recommendations form one cohesive shape change plus a small number of independent improvements. Suggested sequencing:

1. **Type-and-shape rewrite (R1, R2, R3, R4, R5, R6, R7, R10)** — collapse parallel arrays into `routes`, drop `routeId`, retype schemas and IDs, lift fidelity onto kernel definitions, and rename the member types. All UI consumers update in lockstep against the new surface in the same change.
2. **Helper API and subscribe-anytime fix (R8, R9)** — surface `routesFor` / `bestRouteFor` on `RuntimeClient` and emit the current manifest to late subscribers. Both are additive on top of the new shape.
3. **Subpath export (R11)** — once helpers exist, organize the manifest types and helpers under their own subpath.
4. **Delta protocol (R12)** — defer; revisit if/when third-party consumers experience selector-invalidation pain at scale.

## Trade-offs

### Single `routes` field vs. parallel arrays

| Dimension                         | Parallel arrays (current)         | Single `routes` field (R1)                       |
| --------------------------------- | --------------------------------- | ------------------------------------------------ |
| Wire payload                      | ~30 KB / push for `presets.all()` | ~18 KB / push (~40% reduction)                   |
| Number of exported types          | 5                                 | 2 (`Manifest`, `Route`)                          |
| Consumer code paths               | 4 fields to navigate              | 1 field; helpers (R8) for common queries         |
| Test mock complexity              | Every test creates 4 mock arrays  | Every test creates 1 mock array                  |
| Discoverability of "edges only"   | Direct (`transcodeEdges`)         | Filter (`routes.filter((r) => r.transcoderId)`)  |
| Discoverability of "exports only" | Direct (`kernelExports`)          | Filter (`routes.filter((r) => !r.transcoderId)`) |
| Backwards compatibility           | n/a — package unreleased          | n/a — package unreleased                         |

The discoverability concern for the two narrow views is real but addressed by helpers (R8). The wire-payload savings, the reduction in test surface, and the elimination of duplicated `schema`/`defaults` payloads all favor the collapsed shape.

### `JSONSchema7` typing vs. opaque `Record<string, unknown>`

| Dimension                   | `Record<string, unknown>`       | `JSONSchema7` (R3)                              |
| --------------------------- | ------------------------------- | ----------------------------------------------- |
| Type precision              | None — every field is `unknown` | Full JSON Schema type information               |
| Cast burden                 | Every consumer casts            | None                                            |
| Dependency added            | None                            | `@types/json-schema` (zero runtime cost)        |
| Schema-extension fields     | Trivially supported             | Supported via JSONSchema7 union with extensions |
| Conformance with Policy §12 | Violation                       | Compliant                                       |

`@types/json-schema` is a small, dependency-free type-only package already transitively present (RJSF depends on it). The cost is near zero; the benefit is removal of every cast.

### Helper API (`bestRouteFor`) vs. consumer-implemented logic

| Dimension                    | No helper (current)                                                       | `bestRouteFor` helper (R8)                              |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Code duplication             | 2 reimplementations today; growing with adoption                          | Single canonical implementation                         |
| Consistency across consumers | Drift inevitable (UI and hero-viewer already diverge on kernel filtering) | Guaranteed by single source                             |
| Testability                  | Each consumer tests its own logic                                         | Helper has its own unit tests; consumers trivially mock |
| Framework opinionation       | None — consumers free to implement any tiebreak                           | Framework expresses preferred ordering                  |

The framework already has an opinion (the worker's `executeExportWithRoute` uses the manifest order and prefers direct routes). Surfacing that opinion to consumers via a helper is a net win and makes the framework's intent explicit.

## Code Examples

### R1: Collapsed manifest shape

Before (current):

```typescript
export type CapabilitiesManifest = {
  kernelExports: ExportFormatCapability[];
  transcodeEdges: TranscodeEdgeCapability[];
  exportRoutes: ExportRoute[];
  renderOptions?: RenderOptionCapability[];
};
```

After (R1 + R5 + R6):

```typescript
export type CapabilitiesManifest = {
  /** All export routes (kernel-direct and transcoder-routed) discovered so far. */
  routes: ExportRoute[];
  /** Render-option schemas declared by loaded kernels, indexed by kernel ID. */
  renderSchemas: Partial<Record<KernelProviderId, KernelRenderSchema>>;
};
```

### R2 + R3 + R4: Cleaned `ExportRoute`

Before:

```typescript
export type ExportRoute = {
  routeId: string; // unused
  targetFormat: FileExtension;
  kernelId: string; // brand lost
  sourceFormat: FileExtension;
  transcoderId?: string;
  fidelity: ExportFidelity;
  schema: Record<string, unknown>; // type lost
  defaults: Record<string, unknown>;
};
```

After:

```typescript
import type { JSONSchema7 } from 'json-schema';

export type ExportRoute = {
  targetFormat: FileExtension;
  kernelId: KernelProviderId;
  sourceFormat: FileExtension;
  transcoderId?: KernelProviderId;
  fidelity: ExportFidelity;
  schema: JSONSchema7;
  defaults: Record<string, unknown>;
};
```

### R8: Helper API for route selection

```typescript
// On RuntimeClient
export type RuntimeClient<...> = {
  /** All export routes for `format` reachable via the active kernel (or all kernels if not yet known). */
  routesFor(format: FileExtension): readonly ExportRoute[];

  /**
   * The best route for `format`, applying framework tiebreak rules:
   * 1. Active-kernel match (when `kernelId` provided)
   * 2. Direct kernel route over transcoded route
   * 3. `brep` fidelity over `mesh`
   * 4. Manifest order
   */
  bestRouteFor(format: FileExtension, kernelId?: KernelProviderId): ExportRoute | undefined;
};
```

Usage at consumer site:

```typescript
// chat-converter.tsx — before (43 lines of selectBestRoutes + deriveAvailableFormats)
const bestRoutes = selectBestRoutes(capabilities, activeKernelId);
const formats = deriveAvailableFormats(capabilities, activeKernelId);

// chat-converter.tsx — after
const formats = useMemo(
  () =>
    Array.from(new Set(client.routes().map((r) => r.targetFormat)))
      .map((f) => client.bestRouteFor(f, activeKernelId))
      .filter(Boolean),
  [client, activeKernelId],
);
```

### R9: Subscribe-anytime semantics for `'capabilities'`

```typescript
// runtime-client.ts — inside on()
on(event, handler) {
  if (event === 'capabilities') {
    handlers.capabilities.add(handler);
    if (_capabilities) {
      handler(_capabilities);  // <-- immediate emission for late subscribers
    }
    return () => handlers.capabilities.delete(handler);
  }
  // ... other events
}
```

## References

- Library API Policy: `docs/policy/library-api-policy.md` — §3 (Flat Options), §5 (Naming), §6 (Subpath Exports), §7 (Subscribe-Anytime Events), §10 (High-Level Wrappers), §11 (No Optional Methods), §12 (TypeScript-First), §16 (Type-Safe Options Helpers)
- Lazy Capabilities Manifest: `docs/research/lazy-capabilities-manifest.md` — architecture this manifest enables
- Runtime Client Type Safety Audit: `docs/research/runtime-client-type-safety-audit.md` — adjacent typing gaps that inform R3 and F14
- Transcoder Edge Source-Format Type Merging: `docs/research/transcoder-edge-source-type-merging.md` — runtime/type deviation that the manifest both creates and reveals
- Export Pipeline v5: `docs/research/export-pipeline-v5.md` — original spec that introduced the manifest
- Export Pipeline Gap Analysis: `docs/research/export-pipeline-gap-analysis.md` — F4 (route metadata propagation) explains the unused `routeId`

## Appendix: Field-by-field disposition matrix

| Field                                  | Decision                          | Rationale                                                       |
| -------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `CapabilitiesManifest.kernelExports`   | **Remove**                        | Vestigial precursor; redundant with `routes` (F1)               |
| `CapabilitiesManifest.transcodeEdges`  | **Remove**                        | Vestigial precursor; redundant with `routes` (F2)               |
| `CapabilitiesManifest.exportRoutes`    | **Rename → `routes`**             | Sole source of truth; field name shorter once it's the only one |
| `CapabilitiesManifest.renderOptions`   | **Restructure → `renderSchemas`** | Index by kernel; required (empty = `{}`); rename (F3, F7)       |
| `ExportFormatCapability` (whole type)  | **Remove**                        | Type follows F1                                                 |
| `TranscodeEdgeCapability` (whole type) | **Remove**                        | Type follows F2                                                 |
| `RenderOptionCapability` (whole type)  | **Rename → `KernelRenderSchema`** | Drops overloaded `*Capability` suffix                           |
| `ExportRoute.routeId`                  | **Remove**                        | Never used as key (F4)                                          |
| `ExportRoute.targetFormat`             | Keep                              | Primary access pattern                                          |
| `ExportRoute.kernelId`                 | **Retype to `KernelProviderId`**  | F9                                                              |
| `ExportRoute.sourceFormat`             | Keep                              | Used by worker for source-options re-validation                 |
| `ExportRoute.transcoderId`             | **Retype to `KernelProviderId`**  | F9; consider `string` until transcoder ID brand exists          |
| `ExportRoute.fidelity`                 | Keep                              | Used by tiebreak logic                                          |
| `ExportRoute.schema`                   | **Retype to `JSONSchema7`**       | F7                                                              |
| `ExportRoute.defaults`                 | Keep                              | Used by RJSF defaults + delta extraction                        |
| `ExportFidelity`                       | Keep                              | Stable enum-like; widely used                                   |
