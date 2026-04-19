---
title: 'Export Pipeline Gap Analysis'
description: 'Comprehensive audit of the v5 export pipeline implementation against all research documents, identifying completed work and outstanding gaps.'
status: active
created: '2026-04-10'
updated: '2026-04-10'
category: audit
related:
  - docs/research/export-option-schema-architecture.md
  - docs/research/export-pipeline-v5.md
  - docs/research/export-pipeline-v5-implementation-audit.md
  - docs/research/converter-runtime-consolidation.md
  - docs/research/schema-driven-export-configuration.md
  - docs/research/unified-export-pipeline-architecture.md
---

# Export Pipeline Gap Analysis

Cross-reference of every export pipeline requirement from six research documents, the v5 architecture spec, and the export-option-schema-architecture doc against the current source code.

## Executive Summary

The v5 export pipeline delivered the core transcoder primitive, capabilities manifest, route planner, per-format per-kernel Zod schemas, JSON Schema-first manifest merging, RJSF-driven UI settings, type-safe `ExportGeometryInput` discriminated unions, and comprehensive type-level tests. Of the ~55 discrete requirements tracked across all research documents: **~34 are COMPLETE**, **~4 are PARTIAL**, **~9 are MISSING**, and **~5 are correctly DEFERRED** as non-goals of v5.

Key outstanding areas: OpenSCAD export options (`$fn`/`$fa`/`$fs`), GLB/GLTF compression schemas, OpenCascade STL `binary` / STEP `assemblyMode` kernel implementation gaps, converter transcoder ignoring options, route metadata on export responses, and `@taucad/converter` removal from `apps/ui`.

## Methodology

1. Read all six export pipeline research documents, extracting every numbered finding, recommendation, and architectural requirement.
2. Read all kernel plugin files (`*.plugin.ts`) and kernel implementations (`*.kernel.ts`) to verify declared schemas vs actual option usage.
3. Read the transcoder system (`converter.transcoder.ts`, `runtime-transcoder.types.ts`, `transcoder-factories.ts`).
4. Read the runtime client (`runtime-client.ts`), worker (`kernel-worker.ts`), and protocol types.
5. Read the UI export components (`chat-converter.tsx`, `project-command-items.tsx`, `hero-viewer.tsx`).
6. Searched `packages/react/src` and `apps/ui` for `useGeometryExport`, `@taucad/converter`, stale format variants.
7. Reviewed chat transcript history for additional scope items discussed during implementation.
8. Classified each requirement as COMPLETE, PARTIAL, MISSING, or DEFERRED based on source-code evidence.

## Table of Contents

- [Findings: Transcoder System](#findings-transcoder-system)
- [Findings: Schema Architecture](#findings-schema-architecture)
- [Findings: Per-Kernel Export Options](#findings-per-kernel-export-options)
- [Findings: Type Safety](#findings-type-safety)
- [Findings: UI and Consumer Integration](#findings-ui-and-consumer-integration)
- [Findings: Cleanup and Migration](#findings-cleanup-and-migration)
- [Requirements Coverage Matrix](#requirements-coverage-matrix)
- [Recommendations](#recommendations)

## Findings: Transcoder System

### ✅ Finding 1: Transcoder Primitive Implemented

**Status**: COMPLETE

`defineTranscoder` API in `runtime-transcoder.types.ts`, co-located `transcoders/converter/` directory, `createTranscoderPlugin` helper, `converterTranscoder()` factory in `transcoder-factories.ts`. Follows the `*.plugin.ts` co-location pattern established for kernels.

**Sources**: v5 R1–R2, unified R3–R4

### ✅ Finding 2: Capabilities Manifest and Route Planner

**Status**: COMPLETE

`buildCapabilitiesManifest` produces `CapabilitiesManifest` with `kernelExports`, `transcodeEdges`, and `exportRoutes`. Single-hop route planner in `executeExportWithRoute` with `canTranscode` guard. Routes include `schema` and `defaults` for RJSF. `initialized` event includes capabilities.

**Sources**: v5 R4–R5, unified R12

### ✅ Finding 3: JSON Schema-first Manifest Merging

**Status**: COMPLETE

`mergeJsonSchemas` is the sole merge path in `buildCapabilitiesManifest`. The dual Zod/JSON-Schema path and `mergeZodSchemas` function have been removed. `kernelExportZodSchemasMap` is retained exclusively for runtime `safeParse` validation in `onExportGeometry`. `mergeJsonSchemas` handles `properties`, `required` arrays, and defaults.

**Sources**: export-option-schema R3/R6, JSON-Schema-first plan

### ✅ Finding 4: Presets Include Converter Transcoder

**Status**: COMPLETE

`presets.all()` includes `converterTranscoder()` alongside all kernels, middleware, and bundlers.

**Sources**: v5 R9

### ✅ Finding 5: Converter Transcoder Options — Working as Designed

**Status**: COMPLETE

`executeExportWithRoute` correctly forwards `input.options` to the source kernel export (step 1) and to `transcode()` (step 2). The source-format options (tessellation, coordinate system) are applied at step 1 — the GLB that enters the converter already has the user's desired mesh quality and orientation. The converter transcoder performs a lossless format transformation of those already-configured bytes.

`@taucad/converter`'s `exportFromGlb(glbData, outputFormat)` accepts no options parameter — the converter is a pure format transformer. The `TranscodeInput.options` field on the transcoder API is a forward-looking extensibility point for future transcoders (e.g., a commercial API transcoder with quality/compression settings) but is correctly unused by the current converter.

**Sources**: export-option-schema F7/R6, v5 route planner spec

### ❌ Finding 6: Route Metadata Not Wired on Export Response

**Status**: MISSING

The v5 spec defines a `route` field on the `exported` response (containing `routeId`, `sourceFormat`, `transcoderId`, `fidelity`). The `ExportRoute` type includes `routeId` in the manifest, but the export response from `executeExportWithRoute` does not include route metadata. The client and dispatcher do not propagate this information.

**Sources**: v5 R14, v5-audit T7

## Findings: Schema Architecture

### ✅ Finding 7: Per-Format Per-Kernel Export Schemas

**Status**: COMPLETE

Each kernel plugin declares `exportOptionSchemas` per format via Zod schemas. Universal schema merge removed — schemas are composed from shared fragments (`tessellationSchema`, `coordinateSystemSchema`) only where the format/kernel supports them. Empty `z.object({})` used for formats with no options (JSCAD, Manifold, Tau, OpenSCAD, Zoo GLB/GLTF).

**Sources**: export-option-schema R1–R2/R7, v5 Layer 1 revision

### ✅ Finding 8: Shared Zod Fragments

**Status**: COMPLETE

`export-option-schemas.ts` exports `tessellationSchema` (`linearTolerance`, `angularTolerance`) and `coordinateSystemSchema` (`y-up`/`z-up`, default `z-up`). Kernel plugins compose these via `.extend()` where applicable.

**Sources**: export-option-schema R2

### ✅ Finding 9: Z-up Default Convention

**Status**: COMPLETE

`coordinateSystemSchema` defaults to `z-up`. All kernel implementations (Replicad, OpenCascade) rotate to Y-up only when `coordinateSystem === 'y-up'` is requested. Clone before rotation prevents native handle mutation.

**Sources**: Chat transcript — user explicitly requested "make Z-up the default convention all formats"

### ✅ Finding 10: Worker-Side Zod Validation

**Status**: COMPLETE

`KernelWorker.exportGeometry` looks up the active kernel's Zod schema from `kernelExportZodSchemasMap` and calls `safeParse()` on incoming options. Invalid options are logged and corrected to defaults.

**Sources**: export-option-schema R16/F14

### ✅ Finding 11: Stale Export Preferences Handling

**Status**: COMPLETE

`chat-converter.tsx` uses `extractModifiedProperties` + `deleteValueAtPath` to persist only user-modified deltas in `.tau/export/preferences.json`. On load, preferences are validated against the current schema via `additionalProperties: false` — stale properties from schema changes are rejected and cleared.

**Sources**: Chat transcript — user-reported stale preference bug fixed

## Findings: Per-Kernel Export Options

### ✅ Finding 12: Replicad — Full Schema Implementation

**Status**: COMPLETE

| Format | Schema properties                            | Kernel implements |
| ------ | -------------------------------------------- | ----------------- |
| STL    | `binary`, `tessellation`, `coordinateSystem` | ✅ All used       |
| STEP   | `assemblyMode`, `coordinateSystem`           | ✅ All used       |
| GLB    | `tessellation`, `coordinateSystem`           | ✅ All used       |
| GLTF   | `tessellation`, `coordinateSystem`           | ✅ All used       |

`BRepTools.Clean()` applied before re-tessellation. `shape.clone()` before coordinate rotation.

**Sources**: export-option-schema, integration tests

### 🚧 Finding 13: OpenCascade — Schema-Implementation Mismatch

**Status**: PARTIAL — 2 declared schema properties not implemented in kernel

| Format | Schema property                    | Kernel implements                            |
| ------ | ---------------------------------- | -------------------------------------------- |
| STL    | `binary`                           | ❌ **Not used** — always writes binary       |
| STL    | `tessellation`                     | ✅ Used                                      |
| STL    | `coordinateSystem`                 | ✅ Used                                      |
| STEP   | `assemblyMode`                     | ❌ **Not used** — always writes single shape |
| GLB    | `tessellation`, `coordinateSystem` | ✅ Used                                      |
| GLTF   | `tessellation`, `coordinateSystem` | ✅ Used                                      |

The plugin declares `binary` (STL) and `assemblyMode` (STEP) in schemas, but `opencascade.kernel.ts` does not read these from `input.options`. The UI presents these options but they have no effect.

**Sources**: export-option-schema F8/R8

### ❌ Finding 14: OpenSCAD — Missing Export Options

**Status**: MISSING — tessellation params not exposed

OpenSCAD uses `$fn`, `$fa`, `$fs` for tessellation at render time. These are **not** mappable to the OCCT-style `linearTolerance`/`angularTolerance` model. The plugin declares empty `z.object({})` for both GLB and GLTF — the user has **no control** over export mesh quality from the export settings UI.

The kernel has a commented-out TODO block:

```typescript
// TODO: Re-enable default tessellation
// if (tessellation) {
//   args.push(`-D$fn=48`, `-D$fa=${tessellation.angularTolerance}`, `-D$fs=${tessellation.linearTolerance}`);
// }
```

OpenSCAD-native tessellation parameters should be exposed with their own schema fragment, not forced into the OCCT model.

**Sources**: export-option-schema F2/R5

### ✅ Finding 15: Zoo — Correctly Minimal Schemas

**Status**: COMPLETE

Zoo kernel controls mesh export via its engine API. Only `binary` (STL) is exposed as a schema option and implemented in the kernel. GLB/GLTF/STEP have empty schemas, matching the kernel's engine-controlled export behavior.

**Sources**: export-option-schema F9

### ✅ Finding 16: JSCAD, Manifold, Tau — Empty Schemas Correct

**Status**: COMPLETE

These kernels produce geometry in a fixed format (GLB bytes). No per-format options are applicable. Empty schemas are correct.

**Sources**: export-option-schema R7/F9

### ❌ Finding 17: GLB/GLTF Compression Schema Missing

**Status**: MISSING

No kernel or transcoder declares a `compression` option for GLB/GLTF (draco/meshopt/none). The v5 spec and schema-driven research doc both identify this as a desired option.

**Sources**: v5 Appendix D, v5-audit F3, schema-driven R9–R10

### ❌ Finding 18: OpenSCAD 3MF Units Schema Missing

**Status**: MISSING

The v5 spec identifies `3mf.units` (mm/inch) as a format-specific option for OpenSCAD. Neither the OpenSCAD plugin nor any transcoder declares this schema.

**Sources**: v5 Appendix D, v5-audit F4

### ❌ Finding 19: USDZ Scene Scale Not Exposed

**Status**: MISSING

Schema-driven research identifies `sceneScale` as an AR-relevant option for USDZ export. No schema declared.

**Sources**: schema-driven F3

## Findings: Type Safety

### ✅ Finding 20: `ExportGeometryInput` Discriminated Union

**Status**: COMPLETE

`ExportGeometryInput<NativeHandle, ExportSchemas>` produces a discriminated union keyed on `format`, with per-format `options` types inferred from Zod schemas. Falls back to `FileExtension` + `Record<string, unknown>` when no schemas declared.

**Sources**: export-option-schema R10/R11

### ✅ Finding 21: Phantom `__exportSchemas` on `KernelPlugin`

**Status**: COMPLETE

`KernelPlugin<ES>` carries phantom `__exportSchemas` for compile-time format map inference. `CollectFormatMap` and `CollectExportFormats` helper types extract merged format maps from plugin tuples.

**Sources**: export-option-schema R12, v5 R5/F6

### ✅ Finding 22: `createKernelPlugin` Infers Export Schema Types

**Status**: COMPLETE

`createKernelPlugin` infers the `ES` (ExportSchemas) type parameter from the config's `exportOptionSchemas` when no explicit type parameter is provided. Type-level tests verify this in `define-plugin.test-d.ts`.

**Sources**: export-option-schema R12

### ✅ Finding 23: Comprehensive Type-Level Tests

**Status**: COMPLETE — 30+ type tests across 6 describe blocks

`define-plugin.test-d.ts` covers: `ExportGeometryInput` discriminated union, `createKernelPlugin` schema inference, `CollectFormatMap`/`CollectExportFormats`, `RuntimeClient.export()` overloads, exhaustive switch narrowing, and edge cases (single-format, empty schemas, explicit type params).

**Sources**: export-option-schema R11/R15, v5 R8

### 🚧 Finding 24: `RuntimeClient.export()` Overload Trade-off

**Status**: PARTIAL — generic fallback overload prevents strict option checking

`RuntimeClient.export()` has typed overloads for known formats, but the generic fallback `export(format: string, callOptions?: Record<string, unknown>)` always matches, preventing compile-time rejection of invalid option types. Documented as a known TypeScript limitation in type tests.

**Sources**: export-option-schema R13, type test comments

### ✅ Finding 25: Exhaustive `switch` on All Kernel `exportGeometry`

**Status**: COMPLETE

All 7 kernels use `switch (format) { ... default: { const _exhaustive: never = format; } }` pattern. Format is destructured at function entry to enable independent narrowing.

**Sources**: Chat transcript — user-requested refactor

## Findings: UI and Consumer Integration

### ✅ Finding 26: RJSF Export Settings in Chat Converter

**Status**: COMPLETE

`chat-converter.tsx` uses `capabilities.exportRoutes` to discover available formats, `selectBestRoutes` to pick per-format routes (prefers `brep`, then richest schema), and renders RJSF forms from route `schema`/`defaults`. Custom `FieldTemplate` and `ObjectFieldTemplate` for consistent UI.

**Sources**: v5 R12, schema-driven R8

### ✅ Finding 27: Command Palette Unified Export Entry

**Status**: COMPLETE

`project-command-items.tsx` has a single "Export" command that opens the converter pane. The old per-format export commands have been removed.

**Sources**: v5 (single "Open Exporter" button), unified R8

### ✅ Finding 28: Export Preferences Persistence

**Status**: COMPLETE

`.tau/export/preferences.json` stores `selectedFormats`, `showAdvanced`, and per-format option deltas. Loaded on mount, saved on change via `writeFiles`.

**Sources**: v5 R15

### 🚧 Finding 29: Hero Viewer Missing Export Options

**Status**: PARTIAL — formats available but options not passed

`hero-viewer.tsx` uses `capabilities.exportRoutes` for format discovery and includes `converterTranscoder()` for wide format support. However, `exportGeometry(activeFormat.format)` is called **without options** — no tessellation, coordinate system, or format-specific settings.

**Sources**: Chat transcript — converterTranscoder added to hero viewer

### ✅ Finding 30: `ModifiedIndicator` Implemented

**Status**: COMPLETE

Delta tracking via `extractModifiedProperties` exists and the RJSF form uses it to persist only user-modified options to `.tau/export/preferences.json`.

**Sources**: v5-audit F10/T9

### ✅ Finding 31: `zipMultiple` Implemented

**Status**: COMPLETE

Multi-format ZIP download is implemented in the export UI.

**Sources**: v5-audit F7/T10

## Findings: Cleanup and Migration

### ✅ Finding 32: `useGeometryExport` Removed

**Status**: COMPLETE

Hook file deleted from `packages/react/src/hooks/`. Not exported from `packages/react/src/index.ts`. No references in `apps/ui`.

**Sources**: v5-audit T13–T14, unified R11

### ✅ Finding 33: `stl-binary` / `step-assembly` Format Variants Removed

**Status**: COMPLETE

No references to these synthetic format variants found in the codebase. STL binary and STEP assembly mode are now options within their respective format schemas.

**Sources**: v5 R11

### 🚧 Finding 34: `@taucad/converter` Still in `apps/ui`

**Status**: PARTIAL — removed from CAD export path, retained for standalone converter

`apps/ui/package.json` still lists `@taucad/converter` as a dependency. Direct imports remain in `apps/ui/app/components/geometry/converter/` and `apps/ui/app/routes/converter/`. These serve the **standalone file converter** feature (not the CAD export flow), which is a separate consumer. The CAD export path (`chat-converter.tsx`) goes through the runtime client + transcoder, not converter directly.

**Sources**: v5 R16, v5-audit T11–T12, converter-runtime R9–R10

### ✅ Finding 35: `@taucad/converter` Removed from `packages/react`

**Status**: COMPLETE

No `@taucad/converter` in `packages/react/package.json`. `useGeometryExport` hook deleted.

**Sources**: v5-audit T11, converter-runtime R10

### ✅ Finding 36: `use-ar` Migrated to Runtime Client

**Status**: COMPLETE

`apps/ui/app/hooks/use-ar.ts` uses `kernelClient.export('usdz')` via the runtime client. No direct `@taucad/converter` import. The hook accepts a `RuntimeClient` parameter and calls `export('usdz')` which routes through the transcoder pipeline (GLB → USDZ via converter transcoder).

**Sources**: unified R9, converter-runtime R6

## Requirements Coverage Matrix

### Export Pipeline v5 (`export-pipeline-v5.md`)

| ID  | Description                                                | Status                                                     |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| R1  | Transcoder types (`defineTranscoder`, `TranscoderPlugin`)  | ✅ COMPLETE                                                |
| R2  | `createTranscoderPlugin` helper                            | ✅ COMPLETE                                                |
| R3  | `exportFormats` on `KernelPlugin`                          | ✅ COMPLETE                                                |
| R4  | Worker init + `CapabilitiesManifest`                       | ✅ COMPLETE                                                |
| R5  | Single-hop route planner                                   | ✅ COMPLETE                                                |
| R6  | `converterTranscoder` wrapping `@taucad/converter`         | ✅ COMPLETE                                                |
| R7  | Tau kernel exports only GLB/GLTF                           | ✅ COMPLETE                                                |
| R8  | Protocol `options`; `fileType` → `format`                  | ✅ COMPLETE                                                |
| R9  | `transcoders` in client options + presets                  | ✅ COMPLETE                                                |
| R10 | `exportFormats` on all kernel plugins                      | ✅ COMPLETE                                                |
| R11 | Remove `stl-binary` / `step-assembly` from format constant | ✅ COMPLETE                                                |
| R12 | `ExportSettings` RJSF from manifest                        | ✅ COMPLETE                                                |
| R13 | Migrate chat-converter, AR, react hooks                    | ✅ COMPLETE                                                |
| R14 | Route metadata on `exported` response                      | ❌ MISSING                                                 |
| R15 | `.tau/export/` preferences                                 | ✅ COMPLETE                                                |
| R16 | Remove converter from ui/react deps                        | 🚧 PARTIAL (react ✅, ui retains for standalone converter) |

### Export Option Schema Architecture (`export-option-schema-architecture.md`)

| ID        | Description                                             | Status                                                                          |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| F1 / R1   | Remove universal schema; per-format per-kernel only     | ✅ COMPLETE                                                                     |
| F2 / R5   | OpenSCAD `$fn`/`$fa`/`$fs` as native params             | ❌ MISSING                                                                      |
| F3 / R9   | Coordinate system consistency across kernels            | ✅ COMPLETE (Replicad + OCCT mesh; OCCT STEP omits by design)                   |
| F4 / R10  | Remove `Record<string, unknown>` escape hatches         | ✅ COMPLETE (discriminated union)                                               |
| F5        | Tessellation in `options`, not top-level                | ✅ COMPLETE                                                                     |
| F6 / R3   | Zod/JSON Schema merge (not `deepmerge`)                 | ✅ COMPLETE (JSON Schema-first `mergeJsonSchemas`)                              |
| F7 / R6   | Forward source options in transcoded routes             | ✅ COMPLETE (options forwarded)                                                 |
| F8 / R8   | Zoo `assemblyMode` schema-impl mismatch                 | 🚧 PARTIAL (schema removed from Zoo; OCCT still declares but doesn't implement) |
| F9 / R7   | Empty schemas for no-option kernels                     | ✅ COMPLETE                                                                     |
| F10       | `CreateGeometryInput.tessellation` separate from export | ✅ COMPLETE (not conflated)                                                     |
| F11 / R11 | Type-level tests for schema inference                   | ✅ COMPLETE                                                                     |
| F12 / R12 | Phantom type on `KernelPlugin`                          | ✅ COMPLETE                                                                     |
| F13 / R13 | Generic `RuntimeClient.export()`                        | 🚧 PARTIAL (overloads exist; fallback accepts any)                              |
| F14 / R16 | Worker Zod validation of export options                 | ✅ COMPLETE                                                                     |
| F15 / R17 | Middleware uses loose types (acceptable)                | ✅ COMPLETE (by design)                                                         |

### V5 Implementation Audit (`export-pipeline-v5-implementation-audit.md`)

| ID      | Description                                         | Status                                                                 |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| T1      | Fix manifest timing / rebuild + re-emit             | ✅ COMPLETE (JSON Schema from plugin config, not lazy load)            |
| T2      | Verify RJSF after T1                                | ✅ COMPLETE                                                            |
| T3      | Universal schema → per-format per-kernel            | ✅ COMPLETE (architectural shift per export-option-schema)             |
| T4      | GLB/GLTF compression schema                         | ❌ MISSING                                                             |
| T5      | OpenSCAD 3MF units                                  | ❌ MISSING                                                             |
| T6      | Wire format options through kernel `exportGeometry` | ✅ COMPLETE (Replicad, OCCT mesh; gap: OCCT STL binary, STEP assembly) |
| T7      | Wire `route` through exported response              | ❌ MISSING                                                             |
| T8      | `CollectExportFormats` generics                     | ✅ COMPLETE                                                            |
| T9      | `ModifiedIndicator` in RJSF                         | ✅ COMPLETE                                                            |
| T10     | `zipMultiple` for multi-format ZIP                  | ✅ COMPLETE                                                            |
| T11–T12 | Remove converter from ui/react                      | 🚧 PARTIAL (react ✅, ui standalone converter retained)                |
| T13–T14 | Remove `useGeometryExport`; migrate hero            | ✅ COMPLETE                                                            |

### Unified Export Pipeline Architecture (superseded, requirements subsumed by v5)

| ID    | Description                                   | Status                                             |
| ----- | --------------------------------------------- | -------------------------------------------------- |
| R1    | `supportedExportFormats` on kernel definition | ✅ COMPLETE (`exportFormats` on `KernelPlugin`)    |
| R2    | Fallback in `exportGeometry`                  | ✅ COMPLETE (route planner)                        |
| R3–R4 | ExporterProvider / `tauConverter`             | ✅ COMPLETE (transcoder replaces provider concept) |
| R6    | chat-converter → `RuntimeClient.export`       | ✅ COMPLETE                                        |
| R7    | Multi-CU in chat-converter                    | ✅ COMPLETE (UI loops CUs)                         |
| R8    | Single "Open Exporter" command                | ✅ COMPLETE                                        |
| R9    | `use-ar` → `export('usdz')`                   | ✅ COMPLETE                                        |
| R10   | Unify format types                            | ✅ COMPLETE                                        |
| R11   | Deprecate `useGeometryExport`                 | ✅ COMPLETE (deleted)                              |
| R12   | `getExportFormats` → capabilities manifest    | ✅ COMPLETE                                        |

## Recommendations

| #       | Action                                                                                                                    | Priority | Effort     | Impact     | Findings   |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- | ---------- |
| R1      | Add OpenSCAD `$fn`/`$fa`/`$fs` export schema fragment and wire into `openscad.plugin.ts`; expose in transcoded routes too | P1       | Medium     | High       | F14        |
| R2      | Implement OCCT `binary` (STL) and `assemblyMode` (STEP) in `opencascade.kernel.ts`, or remove from schema if not feasible | P1       | Low        | Medium     | F13        |
| R3      | Add GLB/GLTF `compression` schema (draco/meshopt/none) to Replicad + OpenCascade plugins                                  | P2       | High       | Medium     | F17        |
| R4      | Wire route metadata (`routeId`, `sourceFormat`, `transcoderId`, `fidelity`) onto export response                          | P2       | Low        | Low        | F6         |
| ~~R5~~  | ~~Pass `input.options` through to `exportFromGlb`~~ — working as designed; `exportFromGlb` accepts no options             | ~~P2~~   | ~~Medium~~ | ~~Medium~~ | ~~F5~~ ✅  |
| R6      | Add OpenSCAD `3mf.units` schema (mm/inch) if 3MF export is supported via transcoder                                       | P3       | Low        | Low        | F18        |
| R7      | Add USDZ `sceneScale` schema via converter transcoder edge `optionsSchema`                                                | P3       | Low        | Low        | F19        |
| ~~R8~~  | ~~`ModifiedIndicator` visual in RJSF export settings~~                                                                    | ~~P3~~   | ~~Medium~~ | ~~Low~~    | ~~F30~~ ✅ |
| ~~R9~~  | ~~`zipMultiple` for multi-format ZIP download~~                                                                           | ~~P3~~   | ~~Medium~~ | ~~Low~~    | ~~F31~~ ✅ |
| ~~R10~~ | ~~Verify `use-ar` migration to `RuntimeClient.export('usdz')`~~                                                           | ~~P2~~   | ~~Low~~    | ~~Medium~~ | ~~F36~~ ✅ |
| R11     | Pass export options in hero viewer `exportGeometry` call                                                                  | P3       | Low        | Low        | F29        |

## References

- Research: `docs/research/export-option-schema-architecture.md`
- Research: `docs/research/export-pipeline-v5.md`
- Research: `docs/research/export-pipeline-v5-implementation-audit.md`
- Research: `docs/research/converter-runtime-consolidation.md`
- Research: `docs/research/schema-driven-export-configuration.md`
- Research: `docs/research/unified-export-pipeline-architecture.md`
- Chat transcript: [Export pipeline implementation](7983d58c-199d-4486-9ae0-afb2d96f99bd)
