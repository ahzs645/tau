---
title: 'Converter Runtime Consolidation'
description: 'Audit of all @taucad/converter dependencies and migration plan to route conversion through @taucad/runtime for unified export, middleware, and provider extensibility'
status: superseded
superseded_by: docs/research/export-pipeline-v2.md
created: '2026-04-08'
updated: '2026-04-08'
category: audit
related:
  - docs/research/unified-export-pipeline-architecture.md
  - docs/research/schema-driven-export-configuration.md
  - docs/policy/library-api-policy.md
---

# Converter Runtime Consolidation

Audit of every `@taucad/converter` import in the codebase, with a migration plan to route all conversion operations through `@taucad/runtime` — enabling unified middleware, export providers, telemetry, and the schema-driven configuration designed in the companion research.

## Executive Summary

16 files across 3 packages import from `@taucad/converter` or `@taucad/converter/formats`. Most are value imports that execute conversion on the main thread (`exportFromGlb`, `importToGlb`), bypassing the runtime's middleware pipeline, worker threading, and export capability discovery. The runtime already has a first-class `export` protocol and `wrapExportGeometry` middleware hook, but these go unused by 6 of the 8 export entry points. This document inventories every dependency, classifies each as "migrate to runtime", "keep as-is", or "re-export from runtime", and provides a phased migration plan following library-api-policy conventions.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Complete Dependency Inventory](#finding-1-complete-dependency-inventory)
- [Finding 2: Dependency Classification](#finding-2-dependency-classification)
- [Finding 3: Package Boundary Violations](#finding-3-package-boundary-violations)
- [Finding 4: Runtime API Gaps Blocking Migration](#finding-4-runtime-api-gaps-blocking-migration)
- [Recommendations](#recommendations)
- [Migration Plan](#migration-plan)
- [API Design](#api-design)

## Problem Statement

Direct `@taucad/converter` imports scatter conversion logic across the application:

1. **UI components** call `exportFromGlb` on the main thread, blocking the UI during WASM execution
2. **The Tau kernel** in `@taucad/runtime` imports `@taucad/converter` directly, creating a hard coupling between the runtime and a specific converter implementation
3. **`@taucad/react`** hooks call `exportFromGlb` directly, bypassing the runtime entirely
4. **Format metadata** (`supportedExportFormats`, `formatConfigurations`) is consumed from the converter package even in contexts that only need display information
5. No conversion operation benefits from runtime middleware (caching, telemetry, coordinate transforms) unless it happens to go through the kernel worker

Per library-api-policy, the runtime should be the single integration point for consumers. The converter should be an internal implementation detail — an exporter provider — not a direct dependency of UI components.

## Methodology

Searched the entire codebase for `@taucad/converter` imports (static and dynamic), `package.json` dependencies, and all references to converter-exported symbols. Classified each import by migration strategy.

## Findings

### Finding 1: Complete Dependency Inventory

#### Value Imports (execute conversion logic)

| #   | File                                                                      | Symbols                                                                                   | Usage                                                           |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| V1  | `apps/ui/app/components/geometry/converter/converter.tsx`                 | `exportFromGlb`                                                                           | Main-thread GLB → format conversion for the Converter component |
| V2  | `apps/ui/app/hooks/use-ar.ts`                                             | `exportFromGlb`                                                                           | Main-thread GLB → USDZ for iOS Quick Look                       |
| V3  | `apps/ui/app/routes/converter/route.tsx`                                  | `importToGlb`, `supportedImportFormats`, `supportedExportFormats`, `formatConfigurations` | Standalone converter page: upload + convert                     |
| V4  | `apps/ui/app/components/icons/file-extension-icon.tsx`                    | `supportedImportFormats`, `supportedExportFormats` (from `/formats`)                      | Maps file extensions to icons                                   |
| V5  | `apps/ui/app/components/geometry/converter/format-selector.tsx`           | `supportedExportFormats` (from `/formats`)                                                | Checkbox list of export formats                                 |
| V6  | `apps/ui/app/components/geometry/converter/converter-utils.ts`            | `formatConfigurations`, `isInputFormatSupported`                                          | Display names, extension validation                             |
| V7  | `apps/ui/app/routes/converter/formats-list.tsx`                           | `formatConfigurations`                                                                    | Marketing/docs format list                                      |
| V8  | `packages/runtime/src/kernels/tau/tau.kernel.ts`                          | `importToGlb`, `exportFromGlb`, `supportedImportFormats`                                  | Tau universal kernel: import + export fallback                  |
| V9  | `packages/runtime/src/middleware/gltf-edge-detection.middleware.ts`       | `createNodeIo`                                                                            | Post-process glTF with edge detection                           |
| V10 | `packages/runtime/src/middleware/gltf-coordinate-transform.middleware.ts` | `createCoordinateTransform`, `createNodeIo`, `createScalingTransform`                     | Y-up/m → Z-up/mm coordinate transform                           |
| V11 | `packages/react/src/hooks/use-geometry-export.ts`                         | `exportFromGlb`                                                                           | Client-side geometry export hook                                |

#### Type-Only Imports

| #   | File                                                                | Symbols                                                          | Usage                                 |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| T1  | `apps/ui/app/routes/projects_.$id/chat-converter.tsx`               | `SupportedExportFormat`                                          | Cookie-stored format selection typing |
| T2  | `apps/ui/app/routes/_index/hero-viewer.tsx`                         | `SupportedExportFormat`                                          | Export control typing                 |
| T3  | `apps/ui/app/components/geometry/converter/converter-file-tree.tsx` | `SupportedExportFormat`                                          | File tree props typing                |
| T4  | `packages/runtime/src/kernels/tau/tau.kernel.ts`                    | `SupportedImportFormat`, `SupportedExportFormat`, `FileResolver` | Kernel typing                         |

#### Test Mocks

| #   | File                                                   | Symbols                        | Usage                          |
| --- | ------------------------------------------------------ | ------------------------------ | ------------------------------ |
| M1  | `packages/runtime/src/kernels/tau/tau.kernel.test.ts`  | `importToGlb`, `exportFromGlb` | `vi.mock('@taucad/converter')` |
| M2  | `packages/react/src/hooks/use-geometry-export.test.ts` | `exportFromGlb`                | `vi.mock('@taucad/converter')` |

#### package.json Dependencies

| Package                         | Dependency                       |
| ------------------------------- | -------------------------------- |
| `apps/ui/package.json`          | `@taucad/converter: workspace:*` |
| `packages/runtime/package.json` | `@taucad/converter: workspace:*` |
| `packages/react/package.json`   | `@taucad/converter: workspace:*` |

### Finding 2: Dependency Classification

Each import site falls into one of four migration categories:

| Category                   | Description                                                              | Sites              |
| -------------------------- | ------------------------------------------------------------------------ | ------------------ |
| **Migrate to runtime**     | Conversion calls that should go through `RuntimeClient.export()`         | V1, V2, V11        |
| **Internalize in runtime** | Runtime-internal converter usage that should become an exporter provider | V8, V9, V10        |
| **Re-export from runtime** | Format metadata that consumers need without pulling the full converter   | V3, V4, V5, V6, V7 |
| **Keep as-is**             | Standalone converter route (the converter IS the product here)           | V3 (partial)       |

#### Migrate to Runtime (V1, V2, V11)

These call `exportFromGlb` directly on the main thread when they should use `RuntimeClient.export()`:

- **V1 (`converter.tsx`)**: The chat-converter panel's entire export pipeline should be replaced with `RuntimeClient.export()` calls. GLB data is already available in the kernel worker's native handle.
- **V2 (`use-ar.ts`)**: AR Quick Look should call `client.export('usdz')` — the runtime handles kernel-first export with converter fallback.
- **V11 (`use-geometry-export.ts`)**: The `@taucad/react` hook should call `RuntimeClient.export()` instead of `exportFromGlb`. This enables middleware participation and worker-thread execution.

#### Internalize in Runtime (V8, V9, V10)

These are internal to `@taucad/runtime` and should be restructured:

- **V8 (`tau.kernel.ts`)**: The Tau kernel directly imports `exportFromGlb` and `importToGlb`. When the runtime gains exporter provider support, the Tau kernel becomes a thin wrapper that delegates export to the registered provider chain rather than importing converter directly.
- **V9, V10 (middleware)**: These middleware files import `createNodeIo`, `createCoordinateTransform`, `createScalingTransform` from the converter. These are gltf-transform utilities that should either be:
  - (a) Re-exported from `@taucad/converter` as a lightweight subpath (`@taucad/converter/transforms`)
  - (b) Moved to a shared utility within the runtime package
  - (c) Kept as-is (they import specific utility functions, not the heavy WASM exporter)

#### Re-export from Runtime (V3, V4, V5, V6, V7)

These consume format metadata (`supportedExportFormats`, `formatConfigurations`, `isInputFormatSupported`):

- **V4, V5** already use the lightweight `@taucad/converter/formats` subpath (types + format lists only, no WASM)
- **V3, V6, V7** use `formatConfigurations` (display names, descriptions) from the main entry point

The runtime should re-export format metadata so consumers don't need a direct converter dependency for display purposes.

### Finding 3: Package Boundary Violations

Per library-api-policy, `@taucad/runtime` is the consumer integration point. Direct converter usage in `apps/ui` and `@taucad/react` violates this boundary:

```
Current (fan-out):
  apps/ui ──→ @taucad/converter (main thread export)
  apps/ui ──→ @taucad/runtime   (kernel worker export)
  @taucad/react ──→ @taucad/converter (main thread export)

Target (single integration point):
  apps/ui ──→ @taucad/runtime   (all export paths)
  @taucad/react ──→ @taucad/runtime (all export paths)
  @taucad/runtime ──→ @taucad/converter (internal exporter provider)
```

The converter becomes a runtime-internal dependency — an exporter provider implementation — not a direct dependency of consuming applications.

### Finding 4: Runtime API Gaps Blocking Migration

Before consumer migration, the runtime needs these capabilities:

| Gap                                             | Current State                                | Required For                           |
| ----------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| **No exporter provider interface**              | Kernels handle export or nothing             | V1, V2, V11 — converter fallback       |
| **No format metadata re-export**                | Consumers import format lists from converter | V4, V5, V6, V7 — display-only metadata |
| **No `export('usdz')` support**                 | `ExportFormat` lacks `usdz`                  | V2 — AR Quick Look                     |
| **No multi-CU export**                          | `export()` operates on active CU             | V1 — chat-converter multi-CU           |
| **No import API on RuntimeClient**              | `importToGlb` is converter-only              | V3 — standalone converter route        |
| **No `getExportSchema`**                        | No schema query protocol                     | Schema-driven export UI                |
| **`useGeometryExport` uses converter directly** | Hook bypasses runtime                        | V11 — `@taucad/react` migration        |

## Recommendations

| #   | Action                                                                                    | Priority | Effort | Impact                                          |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------- |
| R1  | Implement `ExporterProvider` interface in runtime (from unified-export-pipeline research) | P0       | Medium | High — foundation for all migration             |
| R2  | Create built-in `tauConverter` provider wrapping `@taucad/converter`                      | P0       | Low    | High — converter becomes a provider             |
| R3  | Widen `ExportFormat` to include converter-only formats (`usdz`, `obj`, `fbx`, etc.)       | P0       | Medium | High — unblocks AR and extended format support  |
| R4  | Add `@taucad/runtime/format` subpath re-exporting format metadata                         | P1       | Low    | Medium — removes converter dep for display-only |
| R5  | Migrate `converter.tsx` to use `RuntimeClient.export()`                                   | P1       | Medium | High — eliminates main-thread conversion        |
| R6  | Migrate `use-ar.ts` to use `RuntimeClient.export('usdz')`                                 | P1       | Low    | Medium — AR through unified pipeline            |
| R7  | Migrate `useGeometryExport` to use `RuntimeClient.export()`                               | P1       | Medium | Medium — `@taucad/react` consistency            |
| R8  | Refactor Tau kernel to use exporter provider instead of direct converter import           | P2       | Medium | Medium — cleaner internal architecture          |
| R9  | Remove `@taucad/converter` from `apps/ui/package.json` dependencies                       | P2       | Low    | Medium — enforces boundary                      |
| R10 | Remove `@taucad/converter` from `packages/react/package.json` dependencies                | P2       | Low    | Medium — enforces boundary                      |
| R11 | Add import API to RuntimeClient for standalone converter route                            | P3       | Medium | Low — only one consumer                         |
| R12 | Keep standalone converter route (`/converter`) as the only direct converter consumer      | P3       | Low    | Low — acceptable exception                      |

## Migration Plan

### Phase 1: Runtime Foundation (R1, R2, R3)

**Goal**: Runtime can handle all export formats via kernel-first + provider fallback.

1. Define `ExporterProvider` interface with `defineExporterProvider`
2. Create `tauConverter` provider wrapping `@taucad/converter`
3. Widen `ExportFormat` to the superset of kernel + converter formats
4. Register `tauConverter` as the default fallback provider
5. Add fallback resolution logic to `KernelWorker.exportGeometry`

**Validation**: Existing kernel tests pass; new tests verify fallback export for formats like `usdz`, `obj` via the converter provider.

### Phase 2: Format Metadata Re-export (R4)

**Goal**: Consumers access format lists/metadata without importing converter.

1. Add `@taucad/runtime/format` subpath export:

```typescript
// packages/runtime/src/format/index.ts
export { supportedExportFormats, supportedImportFormats } from '@taucad/converter/formats';
export type { SupportedExportFormat, SupportedImportFormat } from '@taucad/converter/formats';
export { formatConfigurations } from '@taucad/converter';
```

2. Migrate `file-extension-icon.tsx`, `format-selector.tsx`, `converter-utils.ts`, `formats-list.tsx` to import from `@taucad/runtime/format`

**Note**: The converter's `/formats` subpath is already lightweight (no WASM). The runtime re-export adds an indirection layer that enables future decoupling (e.g., runtime could synthesize format lists from registered providers instead of forwarding converter's static list).

### Phase 3: Export Path Migration (R5, R6, R7)

**Goal**: All export operations route through `RuntimeClient.export()`.

1. **`converter.tsx`** (V1): Replace `getGlbData` + `exportFromGlb` with per-CU `RuntimeClient.export()` calls. The chat-converter panel receives kernel clients from compilation units instead of raw GLB bytes.

2. **`use-ar.ts`** (V2): Replace `exportFromGlb(content, 'usdz')` with `kernelClient.export('usdz')`. The runtime's fallback resolution handles USDZ via the converter provider.

3. **`useGeometryExport`** (V11 in `@taucad/react`): Replace `exportFromGlb` with `RuntimeClient.export()`. The hook needs a `RuntimeClient` reference instead of raw `Geometry[]`. This changes the hook's API — it becomes a runtime-aware export hook:

```typescript
// Before (converter-dependent):
useGeometryExport({ geometries, defaultFilename });

// After (runtime-dependent):
useExport({ client, format, defaultFilename });
```

This is a breaking change for `@taucad/react`; version accordingly per the package release skill.

### Phase 4: Internal Cleanup (R8, R9, R10)

**Goal**: Converter is only a runtime-internal dependency.

1. Refactor Tau kernel to use the exporter provider chain instead of importing `exportFromGlb` directly
2. Remove `@taucad/converter` from `apps/ui/package.json`
3. Remove `@taucad/converter` from `packages/react/package.json`
4. Verify `packages/runtime/package.json` is the only non-converter consumer with a converter dependency

### Phase 5: Standalone Converter Exception (R11, R12)

The standalone converter route (`/converter`) is a product feature — an independent file conversion tool, not a CAD export. Two options:

**Option A**: Keep `/converter` as a direct converter consumer (acceptable exception). It's a standalone tool that doesn't operate on CAD geometry and doesn't need middleware/kernel integration.

**Option B**: Add `RuntimeClient.import()` and route `/converter` through the runtime. Enables future features (import preview with kernel tessellation, import → edit → export workflow).

**Recommendation**: Option A for now. The standalone converter is a bounded context. If import-edit-export workflows become a product priority, migrate then.

## API Design

### Runtime Format Subpath

Per library-api-policy section 6 (subpath exports), add a `format` subpath:

```json
{
  "exports": {
    "./format": "./src/format/index.ts"
  }
}
```

Re-exports format metadata for display-only consumers:

```typescript
// @taucad/runtime/format
export {
  supportedExportFormats,
  supportedImportFormats,
  formatConfigurations,
  isInputFormatSupported,
  isOutputFormatSupported,
} from '@taucad/converter/formats';

export type { SupportedExportFormat, SupportedImportFormat } from '@taucad/converter/formats';
```

### Exporter Provider Registration

Per library-api-policy section 8 (plugin factories):

```typescript
// @taucad/runtime
import { createRuntimeClient } from '@taucad/runtime';
import { tauConverter } from '@taucad/runtime/exporter';

const client = createRuntimeClient({
  kernels: [replicad()],
  exporters: [tauConverter()],
});
```

The `tauConverter` factory returns a plain object (policy section 8) with lazy initialization (policy section 9):

```typescript
export function tauConverter(): ExporterProvider {
  return {
    id: 'tau-converter',
    capabilities: [
      { format: 'stl', quality: 'mesh' },
      { format: 'step', quality: 'mesh' },
      { format: 'obj', quality: 'mesh' },
      { format: 'fbx', quality: 'mesh' },
      { format: 'usdz', quality: 'mesh' },
      // ... all converter formats
    ],
    async exportFromGlb(glbData, format, options) {
      const { exportFromGlb } = await import('@taucad/converter');
      return exportFromGlb(glbData, format);
    },
  };
}
```

### Dependency Graph After Migration

```
apps/ui
  └── @taucad/runtime         (export, format metadata, everything)
  └── @taucad/react            (hooks wrapping runtime)

@taucad/react
  └── @taucad/runtime          (RuntimeClient for export)

@taucad/runtime
  └── @taucad/converter        (internal: tauConverter provider, middleware transforms)

@taucad/converter              (standalone: only direct consumer is /converter route)
```

## References

- Unified Export Pipeline Architecture: `docs/research/unified-export-pipeline-architecture.md`
- Schema-Driven Export Configuration: `docs/research/schema-driven-export-configuration.md`
- Library API Policy: `docs/policy/library-api-policy.md`
- API Evolution Policy: `docs/policy/api-evolution-policy.md`
- Runtime client: `packages/runtime/src/client/runtime-client.ts`
- Converter package: `packages/converter/src/index.ts`
- Converter formats subpath: `packages/converter/src/formats.ts`

## Appendix

### A. Import Count by Symbol

| Symbol                      | Import Count (excl. converter internals) | Migration Impact                     |
| --------------------------- | ---------------------------------------- | ------------------------------------ |
| `exportFromGlb`             | 5 (3 value, 2 mock)                      | High — core export function          |
| `SupportedExportFormat`     | 6 (all type-only)                        | Low — type re-export                 |
| `supportedExportFormats`    | 3 (value)                                | Low — metadata re-export             |
| `formatConfigurations`      | 3 (value)                                | Low — metadata re-export             |
| `importToGlb`               | 2 (value)                                | Medium — import pipeline             |
| `SupportedImportFormat`     | 3 (type-only)                            | Low — type re-export                 |
| `supportedImportFormats`    | 2 (value)                                | Low — metadata re-export             |
| `createNodeIo`              | 2 (value)                                | Low — internal to runtime middleware |
| `createCoordinateTransform` | 1 (value)                                | Low — internal to runtime middleware |
| `createScalingTransform`    | 1 (value)                                | Low — internal to runtime middleware |
| `isInputFormatSupported`    | 1 (value)                                | Low — metadata re-export             |
| `FileResolver`              | 1 (type-only)                            | Low — internal to Tau kernel         |

### B. Files That Will Remove `@taucad/converter` Dependency

After full migration, these files no longer import from `@taucad/converter`:

| Phase | File                                        | New Import Source                 |
| ----- | ------------------------------------------- | --------------------------------- |
| 3     | `apps/ui/.../converter.tsx`                 | `@taucad/runtime` (client.export) |
| 3     | `apps/ui/.../use-ar.ts`                     | `@taucad/runtime` (client.export) |
| 3     | `packages/react/.../use-geometry-export.ts` | `@taucad/runtime` (client.export) |
| 2     | `apps/ui/.../file-extension-icon.tsx`       | `@taucad/runtime/format`          |
| 2     | `apps/ui/.../format-selector.tsx`           | `@taucad/runtime/format`          |
| 2     | `apps/ui/.../converter-utils.ts`            | `@taucad/runtime/format`          |
| 2     | `apps/ui/.../formats-list.tsx`              | `@taucad/runtime/format`          |
| 2     | `apps/ui/.../chat-converter.tsx`            | `@taucad/runtime/format` (type)   |
| 2     | `apps/ui/.../hero-viewer.tsx`               | `@taucad/runtime/format` (type)   |
| 2     | `apps/ui/.../converter-file-tree.tsx`       | `@taucad/runtime/format` (type)   |

Files that **retain** `@taucad/converter` dependency:
| File | Reason |
|---|---|
| `apps/ui/.../routes/converter/route.tsx` | Standalone converter product (acceptable exception) |
| `packages/runtime/.../tau.kernel.ts` | Internal provider (Phase 4 refactor) |
| `packages/runtime/.../gltf-edge-detection.middleware.ts` | Internal utility (acceptable) |
| `packages/runtime/.../gltf-coordinate-transform.middleware.ts` | Internal utility (acceptable) |
