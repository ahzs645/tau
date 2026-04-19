---
title: 'Unified Export Pipeline Architecture'
description: 'Audit of the fragmented export landscape, API architecture for consolidating all export paths into the runtime kernel pipeline with fallback converters and multi-CU support'
status: superseded
superseded_by: docs/research/export-pipeline-v2.md
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/research/geometry-data-transfer-architecture.md
  - docs/research/geometry-pipeline-copy-audit.md
  - docs/research/schema-driven-export-configuration.md
  - docs/research/converter-runtime-consolidation.md
---

# Unified Export Pipeline Architecture

Audit of the current export landscape across Tau, identifying fragmentation points, and designing a unified export pipeline that routes all exports through the runtime kernel — with graceful fallback to `@taucad/converter` and future commercial exporters (e.g., Zoo API).

## Executive Summary

The export system has two independent pipelines that diverge in capabilities, threading model, unit/coordinate handling, and format coverage. **Path A** (kernel-side, worker thread) provides first-class STEP/STL via native handles but is only accessible via `project-command-items.tsx` and the preview page. **Path B** (client-side, main thread) uses `exportFromGlb` from `@taucad/converter` and powers the chat-converter panel, AR Quick Look, the hero viewer, and the standalone converter route. Neither path supports multi-compilation-unit export. The two paths use incompatible format type systems (`ExportFormat` vs `SupportedExportFormat`), apply coordinate/unit transforms inconsistently, and cannot leverage each other's strengths. This document proposes consolidating all export operations into a single runtime-mediated pipeline with kernel-first export, converter fallback, and an extensible exporter provider interface.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Two Parallel Export Pipelines](#finding-1-two-parallel-export-pipelines)
- [Finding 2: Format Type System Split](#finding-2-format-type-system-split)
- [Finding 3: Single-CU Export Only](#finding-3-single-cu-export-only)
- [Finding 4: Coordinate and Unit Transform Inconsistency](#finding-4-coordinate-and-unit-transform-inconsistency)
- [Finding 5: Main-Thread Conversion Blocks UI](#finding-5-main-thread-conversion-blocks-ui)
- [Finding 6: AR Quick Look Bypass](#finding-6-ar-quick-look-bypass)
- [Finding 7: Middleware Cannot Participate in Path B](#finding-7-middleware-cannot-participate-in-path-b)
- [Finding 8: No Export Format Capability Discovery](#finding-8-no-export-format-capability-discovery)
- [Target Architecture](#target-architecture)
- [API Design](#api-design)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)

## Problem Statement

Several forces converged to fracture the export system:

1. **Compilation units** were added to the project machine, making multi-file projects first-class, but exports still hardcode `mainEntryFile` as the sole geometry source.
2. The **chat-converter panel** (`chat-converter.tsx`) performs all conversion on the main thread via `exportFromGlb`, bypassing the kernel worker entirely — losing access to native handles, middleware transforms, and first-class kernel export capabilities.
3. The **command palette** (`project-command-items.tsx`) duplicates export UI as a separate entry point, creating divergent user flows that cannot share state, format selection, or multi-CU awareness.
4. **AR Quick Look** (`use-ar.ts`) directly calls `exportFromGlb(glbGeometry.content, 'usdz')` on the main thread, bypassing all runtime infrastructure.
5. The `useGeometryExport` hook in `@taucad/react` provides a third independent export path for the hero viewer.
6. There is no mechanism for the runtime to advertise which formats a kernel natively supports, making intelligent fallback to converters impossible.

## Methodology

Source analysis of all export-related files across `apps/ui`, `packages/runtime`, `packages/react`, `packages/converter`, and `libs/types`. Cross-referenced kernel implementations, middleware types, protocol messages, UI components, and type definitions to map the complete export data flow.

## Findings

### Finding 1: Two Parallel Export Pipelines

The product has two structurally independent export paths:

| Dimension           | Path A: Kernel Worker                                                  | Path B: Client Converter                                                                         |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Thread**          | Worker (off main thread)                                               | Main thread                                                                                      |
| **Entry points**    | Command palette, preview page                                          | Chat-converter panel, AR, hero viewer, standalone converter                                      |
| **Geometry source** | Native handle (BRep shapes, WASM objects)                              | GLB bytes from rendered geometry                                                                 |
| **Format types**    | `ExportFormat` (`@taucad/types`)                                       | `SupportedExportFormat` (`@taucad/converter`)                                                    |
| **Middleware**      | Yes (`wrapExportGeometry`)                                             | No                                                                                               |
| **STEP quality**    | Native BRep (lossless)                                                 | Assimp mesh reconstruction (lossy)                                                               |
| **USDZ support**    | No                                                                     | Yes (Assimp exporter)                                                                            |
| **Format count**    | 7 (`stl`, `stl-binary`, `step`, `step-assembly`, `glb`, `gltf`, `3mf`) | 14 (`3ds`, `dae`, `fbx`, `glb`, `gltf`, `obj`, `ply`, `stl`, `step`, `usda`, `usdz`, `x`, `x3d`) |

**Impact**: Users get different export quality depending on which UI element they click. STEP exported from the command palette preserves BRep geometry; STEP exported from the chat-converter panel passes through GLB→Assimp mesh reconstruction, producing a dramatically inferior result. There is no indication of this quality difference in the UI.

### Finding 2: Format Type System Split

Two incompatible union types represent export formats:

**`ExportFormat`** (`libs/types/src/constants/file.constants.ts`):

```
'stl' | 'stl-binary' | 'step' | 'step-assembly' | 'glb' | 'gltf' | '3mf'
```

**`SupportedExportFormat`** (`packages/converter/src/formats.ts`):

```
'3ds' | 'dae' | 'fbx' | 'glb' | 'gltf' | 'obj' | 'ply' | 'stl' | 'step' | 'usda' | 'usdz' | 'x' | 'x3d'
```

The runtime `ExportFormat` includes `stl-binary`, `step-assembly` which have no converter equivalent. The converter `SupportedExportFormat` includes `usdz`, `fbx`, `obj`, `ply`, etc. which have no runtime equivalent. The intersection is only `stl`, `step`, `glb`, `gltf`. The Tau kernel bridges this gap with a `fileType as SupportedExportFormat` cast, but this is fragile.

### Finding 3: Single-CU Export Only

Both pipelines hardcode the main compilation unit:

- **`chat-converter.tsx`** (line 70): `const cadActor = compilationUnits.get(mainEntryFile);` — only reads geometry from the main CU.
- **`project-command-items.tsx`** (line 23): `const cadActor = compilationUnits.get(mainEntryFile);` — same pattern.
- **`export-geometry.machine.ts`**: Accepts a single `cadRef`, not a collection.

Multi-CU projects (assemblies, multi-part designs) cannot export all parts together. There is no concept of "export all CUs" or "select which CUs to export" in any UI path.

### Finding 4: Coordinate and Unit Transform Inconsistency

Format conventions are handled ad-hoc per kernel with no framework-level enforcement:

| Format   | Convention                   | Where Applied                                                                                                                                                                            |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glTF/GLB | Y-up, meters                 | OpenSCAD: `createGlb` (Z-up mm → Y-up m); Replicad: `convertReplicadGeometriesToGltf`; Manifold: pre-baked in `createGeometry`; Converter: `normalizeGlbToYup` for imported Z-up sources |
| STL      | No axis/unit standard        | Replicad: raw OCCT output (mm, Z-up); OpenSCAD: `convertOffToStl` (mm, Z-up); Zoo: explicit `units: 'mm'`                                                                                |
| STEP     | No axis standard, mm typical | Replicad: raw OCCT BRep; OpenCascade: STEP writer defaults                                                                                                                               |
| 3MF      | mm unit in XML               | OpenSCAD: explicit `unit="millimeter"` attribute                                                                                                                                         |
| USDZ     | Y-up, meters (AR convention) | Converter: no explicit transform applied — inherits whatever glTF has                                                                                                                    |

**Problem**: When the chat-converter path exports STEP from GLB (Path B), it passes through Assimp which may introduce coordinate system artifacts that the kernel-native path (Path A) would avoid. When exporting USDZ for AR, the converter inherits glTF's Y-up/meters — which is correct by coincidence, not by design.

The converter package exports `createCoordinateTransform`, `createScalingTransform`, and their reverses, but these are only used by import loaders — no export path calls them to normalize output for target format conventions.

### Finding 5: Main-Thread Conversion Blocks UI

`exportFromGlb` in Path B runs synchronously-blocking async work on the main thread:

- **Assimp WASM** initialization and export (for STL, STEP, FBX, etc.)
- **gltf-transform** document parsing and serialization (for GLB/glTF)

For complex models, this freezes the UI during conversion. The runtime worker pipeline (Path A) naturally avoids this by running in the kernel worker, but Path B cannot benefit without architectural changes.

### Finding 6: AR Quick Look Bypass

`use-ar.ts` performs conversion entirely outside the runtime:

```typescript
const exportedFiles = await exportFromGlb(glbGeometry.content, 'usdz');
```

This means:

- No middleware (e.g., a future AR-specific transform) can participate
- No telemetry/tracing spans around the export
- No fallback to a potentially higher-quality kernel USDZ exporter if one exists
- The USDZ output inherits whatever coordinate system/units the GLB had

### Finding 7: Middleware Cannot Participate in Path B

The runtime's `wrapExportGeometry` middleware hook provides a powerful onion-pattern interception point for export operations, but it is only available for Path A exports. Path B bypasses the runtime entirely. This means:

- Export caching (via middleware) only works for command palette exports
- Export-time transforms (e.g., applying specific tessellation for STL) are unavailable
- Future commercial exporter providers cannot be injected as middleware for Path B
- Export analytics/telemetry middleware has no access to converter-based exports

### Finding 8: No Export Format Capability Discovery

The runtime defines `KernelWorker.getExportFormats()` which reads a static `supportedExportFormats` array, but this is `[]` in the base class and no kernel overrides it. There is no mechanism for:

- The UI to query which formats a kernel natively supports vs which need converter fallback
- The runtime to automatically route: "Use kernel STEP if available, else fall back to converter STEP"
- The user to see quality indicators (e.g., "Native BRep" vs "Mesh approximation") in the export UI

Per-kernel native support (from source analysis):

| Format           | Replicad      | OpenCascade   | Manifold | OpenSCAD | JSCAD  | Zoo    | Tau               |
| ---------------- | ------------- | ------------- | -------- | -------- | ------ | ------ | ----------------- |
| stl/stl-binary   | Native        | Native        | —        | Native   | —      | Native | Converter         |
| step             | Native (BRep) | Native (BRep) | —        | —        | —      | Native | Converter (lossy) |
| step-assembly    | Native (BRep) | Native        | —        | —        | —      | —      | —                 |
| glb/gltf         | Native        | Native        | Native   | Native   | Native | Native | Converter         |
| 3mf              | —             | —             | —        | Native   | —      | —      | Converter         |
| usdz             | —             | —             | —        | —        | —      | —      | Converter         |
| obj/fbx/ply/etc. | —             | —             | —        | —        | —      | —      | Converter         |

## Target Architecture

### Design Principles

1. **Kernel-first export**: Always prefer the kernel's native `exportGeometry` when the requested format is natively supported — preserving BRep fidelity for STEP, native tessellation for STL, etc.
2. **Graceful fallback**: When the kernel lacks native support for a format, the runtime automatically falls back to converter-based export from the kernel's GLB output, with appropriate coordinate/unit transforms applied.
3. **Single pipeline**: All export operations — chat panel, AR, command palette, `@taucad/react` hooks — go through `RuntimeClient.export()` or its React wrapper.
4. **Multi-CU awareness**: The export API accepts an optional CU selector; the UI can export individual CUs or all CUs.
5. **Exporter provider extensibility**: Third-party exporters (e.g., Zoo API as a service-side converter) can be registered as fallback providers.
6. **Format convention enforcement**: The runtime applies format-specific post-processing (Y-up/meters for glTF, mm for 3MF, etc.) as a framework concern, not per-kernel ad-hoc code.

### Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│  UI Layer                                               │
│  ┌──────────────────┐  ┌─────────────────┐              │
│  │ Chat Exporter    │  │ AR Quick Look   │              │
│  │ Panel (all CUs)  │  │ (via export())  │              │
│  └────────┬─────────┘  └───────┬─────────┘              │
│           │                    │                        │
│  ┌────────▼────────────────────▼─────────┐              │
│  │ useExport() / useCadExport()          │  @taucad/react│
│  │ (unified hook, CU-aware)              │              │
│  └────────┬──────────────────────────────┘              │
├───────────┼─────────────────────────────────────────────┤
│  Runtime  │                                             │
│  ┌────────▼──────────────────────────────┐              │
│  │ RuntimeClient.export(format, options) │              │
│  │ ┌──────────────────────────────────┐  │              │
│  │ │ Format Resolution                │  │              │
│  │ │ 1. Check kernel.supportedFormats │  │              │
│  │ │ 2. If native → kernel export     │  │              │
│  │ │ 3. If not → fallback strategy    │  │              │
│  │ └──────────┬───────────────────────┘  │              │
│  └────────────┼──────────────────────────┘              │
│  ┌────────────▼──────────────────────────┐              │
│  │ Worker Thread                         │              │
│  │ ┌──────────────────────────────────┐  │              │
│  │ │ Middleware Onion                 │  │              │
│  │ │ (wrapExportGeometry)            │  │              │
│  │ └──────────┬───────────────────────┘  │              │
│  │ ┌──────────▼───────────────────────┐  │              │
│  │ │ Export Strategy Router           │  │              │
│  │ │ ┌───────────┐ ┌───────────────┐  │  │              │
│  │ │ │  Kernel   │ │  Fallback     │  │  │              │
│  │ │ │  Native   │ │  Exporter     │  │  │              │
│  │ │ │  Export   │ │  (converter/  │  │  │              │
│  │ │ │          │ │   commercial) │  │  │              │
│  │ │ └───────────┘ └───────────────┘  │  │              │
│  │ └──────────────────────────────────┘  │              │
│  └───────────────────────────────────────┘              │
├─────────────────────────────────────────────────────────┤
│  Exporter Providers                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ @taucad/      │ │ Zoo API      │ │ Custom           │ │
│  │ converter     │ │ Exporter     │ │ Exporter         │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## API Design

### 1. Kernel Format Capability Declaration

Kernels declare which formats they natively support via a static property on the definition:

```typescript
export type KernelDefinition<Context, NativeHandle, Options> = {
  // ... existing fields ...

  /** Formats this kernel can natively export from its native handle. */
  supportedExportFormats: readonly ExportFormat[];

  exportGeometry(
    input: ExportGeometryInput<NativeHandle>,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<ExportGeometryResult>;
};
```

Example in Replicad kernel:

```typescript
export default defineKernel({
  name: 'Replicad',
  version: '...',
  supportedExportFormats: ['stl', 'stl-binary', 'step', 'step-assembly', 'glb', 'gltf'],
  // ...
});
```

### 2. Exporter Provider Interface

Following library-api-policy `defineX` conventions, exporter providers are registered as plugins:

```typescript
type ExporterCapability = {
  /** Export format this provider can produce */
  format: ExportFormat;
  /** Quality tier for UI display: 'native' (lossless), 'mesh' (tessellated), 'service' (remote API) */
  quality: 'native' | 'mesh' | 'service';
};

type ExporterProvider = {
  id: string;
  /** Formats this provider can export */
  capabilities: readonly ExporterCapability[];
  /** Convert GLB bytes to the target format */
  exportFromGlb(
    glbData: Uint8Array<ArrayBuffer>,
    format: ExportFormat,
    options?: ExportProviderOptions,
  ): Promise<ExportFile[]>;
};

function defineExporterProvider(provider: ExporterProvider): ExporterProvider;
```

Built-in provider wrapping `@taucad/converter`:

```typescript
const tauConverter = defineExporterProvider({
  id: 'tau-converter',
  capabilities: [
    { format: 'stl', quality: 'mesh' },
    { format: 'step', quality: 'mesh' },
    { format: 'glb', quality: 'mesh' },
    { format: 'gltf', quality: 'mesh' },
    { format: '3mf', quality: 'mesh' },
    // Extended formats via converter
  ],
  async exportFromGlb(glbData, format) {
    const { exportFromGlb } = await import('@taucad/converter');
    return exportFromGlb(glbData, format);
  },
});
```

Future Zoo API provider:

```typescript
const zooExporter = defineExporterProvider({
  id: 'zoo-api',
  capabilities: [
    { format: 'step', quality: 'service' },
    { format: 'stl', quality: 'service' },
  ],
  async exportFromGlb(glbData, format, options) {
    // Upload GLB to Zoo API, receive converted file
  },
});
```

### 3. Registration in RuntimeClient Options

Following the options-merge and plugin-array conventions from library-api-policy:

```typescript
type RuntimeClientOptions = {
  // ... existing fields ...
  exporters?: ExporterProvider[];
};

const client = createRuntimeClient({
  kernels: [replicad()],
  exporters: [tauConverter, zooExporter],
});
```

### 4. Export Resolution Protocol

The runtime resolves the best export strategy per request:

```
1. If kernel.supportedExportFormats includes format:
   → Use kernel.exportGeometry (native handle, worker thread)
   → Apply format-specific post-processing middleware

2. Else, find first registered ExporterProvider with matching format:
   → Request GLB from kernel (via exportGeometry('glb'))
   → Apply pre-export transforms (coordinate system, units)
   → Call provider.exportFromGlb(glbData, format)
   → Apply post-export format conventions

3. Else:
   → Return error with available formats list
```

### 5. Format Convention Middleware

A built-in export middleware applies format-specific conventions as a framework concern:

```typescript
const formatConventionMiddleware = defineMiddleware({
  id: 'format-conventions',
  wrapExportGeometry(input, handler, runtime) {
    const result = await handler(input);
    if (!result.success) return result;
    return applyFormatConventions(result, input.fileType);
  },
});
```

Convention rules:

| Format   | Coordinate System | Units                  | Applied By                               |
| -------- | ----------------- | ---------------------- | ---------------------------------------- |
| glTF/GLB | Y-up              | Meters                 | Framework (post-export)                  |
| STL      | (no spec)         | Millimeters (de facto) | Framework (post-export on fallback path) |
| STEP     | (no spec)         | Millimeters (ISO)      | Kernel native (already correct)          |
| 3MF      | (no spec)         | Millimeters            | Framework (XML attribute)                |
| USDZ     | Y-up              | Meters                 | Framework (inherits glTF, validated)     |

Native kernel exports are assumed to produce correct conventions (kernels own their format knowledge). Fallback exports from GLB apply reverse transforms to match target format expectations.

### 6. Multi-CU Export API

The `RuntimeClient.export` method gains CU selection:

```typescript
type ExportOptions = {
  /** Tessellation quality for this export */
  tessellation?: Tessellation;
  /** Specific compilation unit to export. Omit to export the active CU. */
  compilationUnit?: string;
};

// Single CU (current behavior, backward compatible)
await client.export('step');

// Specific CU
await client.export('step', { compilationUnit: 'wheel.ts' });
```

At the UI layer, the chat-converter panel iterates over all CUs:

```typescript
const { compilationUnits } = useProject();
// Export all CUs that have geometry
for (const [entryFile, cadActor] of compilationUnits) {
  const snapshot = cadActor.getSnapshot();
  if (snapshot.context.geometries.length > 0) {
    await kernelClient.export(format, { compilationUnit: entryFile });
  }
}
```

### 7. Unified React Hook

A single `useExport` hook replaces `useGeometryExport`, `useCadExport`, and the inline export logic in `project-command-items.tsx`:

```typescript
type UseExportOptions = {
  /** Compilation unit to export, or 'all' for all CUs with geometry */
  compilationUnit?: string | 'all';
  /** Base filename for downloads */
  defaultFilename?: string;
  onSuccess?: (filename: string) => void;
  onError?: (error: unknown) => void;
};

type UseExportResult = {
  exportGeometry: (format: ExportFormat, filename?: string) => void;
  isExporting: boolean;
  canExport: boolean;
  /** Formats available for the active kernel, with quality indicators */
  availableFormats: ExportFormatInfo[];
};

type ExportFormatInfo = {
  format: ExportFormat;
  /** How the format will be produced: kernel-native, converter fallback, or service */
  source: 'native' | 'converter' | 'service';
  /** Whether a registered exporter can handle this format */
  available: boolean;
};
```

### 8. Chat-Converter Panel Overhaul

The current `Converter` component and `chat-converter.tsx` are refactored:

1. **Remove** `getGlbData` prop and `exportFromGlb` calls — all conversion goes through `RuntimeClient.export()`.
2. **Add** CU selector: list all compilation units with geometry, allow selecting which to export.
3. **Show** format quality indicators: "Native BRep" badge for kernel-supported formats, "Converted" for fallback.
4. **Remove** export items from `project-command-items.tsx` — the chat-converter panel becomes the sole export UI (command palette can have a single "Open Exporter" command that toggles the panel).

### 9. AR Integration

`use-ar.ts` becomes a thin wrapper around the unified pipeline:

```typescript
export function useAr(compilationUnit?: string): ArCapability {
  const { exportGeometry } = useExport({ compilationUnit });

  const activateAr = useCallback(async () => {
    // Export USDZ through unified pipeline (kernel → converter fallback)
    const result = await exportGeometry('usdz');
    // Launch Quick Look with result
  }, [exportGeometry]);

  // ...
}
```

## Recommendations

| #   | Action                                                                                                     | Priority | Effort | Impact                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------ |
| R1  | Add `supportedExportFormats` to `KernelDefinition` and populate for all kernels                            | P0       | Low    | High — enables format capability discovery                   |
| R2  | Implement fallback export resolution in `KernelWorker.exportGeometry` (kernel-first → converter fallback)  | P0       | Medium | High — eliminates Path A/B split for format coverage         |
| R3  | Define `ExporterProvider` interface with `defineExporterProvider` factory                                  | P1       | Low    | High — extensibility for commercial exporters                |
| R4  | Create built-in `tauConverter` exporter provider wrapping `@taucad/converter`                              | P1       | Low    | Medium — bridges converter into runtime pipeline             |
| R5  | Add format convention middleware for coordinate/unit normalization on fallback path                        | P1       | Medium | High — correctness for USDZ, STL, 3MF exports                |
| R6  | Refactor `chat-converter.tsx` to use `RuntimeClient.export()` instead of `exportFromGlb`                   | P0       | Medium | High — eliminates main-thread conversion, enables middleware |
| R7  | Add multi-CU support to chat-converter panel (CU selector, export-all option)                              | P1       | Medium | High — unblocks multi-part project exports                   |
| R8  | Remove geometry export items from `project-command-items.tsx` in favor of a single "Open Exporter" command | P2       | Low    | Medium — reduces export UI fragmentation                     |
| R9  | Refactor `use-ar.ts` to route through `RuntimeClient.export('usdz')`                                       | P1       | Low    | Medium — AR benefits from middleware and kernel fallback     |
| R10 | Unify `ExportFormat` and `SupportedExportFormat` into a single canonical type owned by the runtime         | P1       | Medium | High — eliminates unsafe casts and format confusion          |
| R11 | Deprecate `useGeometryExport` in `@taucad/react` in favor of `useCadExport` (which goes through runtime)   | P2       | Low    | Medium — removes independent export path                     |
| R12 | Wire `getExportFormats()` protocol command to return merged kernel + provider capabilities                 | P2       | Low    | Medium — enables UI format discovery                         |

## Trade-offs

### Fallback Export in Worker vs Main Thread

**Option A: Run converter in the kernel worker thread**

- Pro: Keeps main thread free; converter WASM runs in same worker
- Con: Converter dependencies (Assimp WASM, gltf-transform) must be importable in the worker; increases worker bundle size
- Con: Long conversions block the geometry pipeline for that CU

**Option B: Run converter in a dedicated export worker**

- Pro: Neither main thread nor kernel worker is blocked; converter has its own WASM memory
- Con: Additional worker lifecycle management; GLB data must be transferred to export worker

**Option C: Run converter in the kernel worker with lazy dynamic import**

- Pro: No bundle size penalty; converter WASM loads only when fallback is needed; same worker thread as kernel
- Con: First fallback export incurs WASM initialization cost

**Recommendation**: Option C — lazy dynamic import in the kernel worker. The `ExporterProvider.exportFromGlb` callback naturally supports `await import('@taucad/converter')` and the one-time WASM init cost is amortizable. If profiling shows worker blocking is problematic, Option B can be introduced later as a provider-level concern (the provider abstraction supports it).

### Unified Format Type vs Extended Format Type

**Option A: Extend `ExportFormat` to include all converter formats**

- Pro: Single type everywhere; no casts
- Con: Every kernel must handle or explicitly error on formats they don't support (e.g., `'usdz'`, `'fbx'`); the type becomes very wide

**Option B: Keep `ExportFormat` as kernel formats, introduce `ExportTarget` as the superset**

- Pro: Kernels only see formats they might handle; UI uses the superset
- Con: Two types, though with a clear relationship (`ExportFormat ⊂ ExportTarget`)

**Option C: `ExportFormat` becomes the superset, kernels declare `supportedExportFormats`**

- Pro: Single type; kernels already error on unsupported formats; `supportedExportFormats` is the constraint mechanism
- Con: Wide type in kernel signatures; requires adding converter-only formats to `@taucad/types`

**Recommendation**: Option C — widen `ExportFormat` to be the canonical superset and let `supportedExportFormats` on the kernel definition serve as the narrowing mechanism. This aligns with the library-api-policy principle of flat options with sensible defaults and avoids the confusion of two overlapping format types.

### Command Palette Export Removal

Removing export items from the command palette simplifies the UI but reduces discoverability for keyboard-driven users. A compromise: keep a single "Export Model" command that opens/focuses the chat-converter panel, rather than individual per-format commands.

## Code Examples

### Current: Fragmented STEP export

```typescript
// Path A: Command palette (kernel-native, high quality)
// project-command-items.tsx
exportActorRef.send({ type: 'requestExport', format: 'step', onSuccess, onError });
// → cad.machine → kernelClient.export('step') → worker → replicad.exportGeometry → shape.blobSTEP()

// Path B: Chat converter (converter fallback, lossy)
// chat-converter.tsx → Converter → converter.tsx
const glb = await getGlbData(); // Read rendered GLB from state
const files = await exportFromGlb(glb, 'step'); // Main thread, Assimp mesh → STEP
```

### Target: Unified export

```typescript
// All paths go through RuntimeClient.export():
// chat-converter.tsx, use-ar.ts, command palette, preview page
await kernelClient.export('step');
// → KernelWorker checks supportedExportFormats
// → Replicad: ['step'] ✓ → native BRep export via shape.blobSTEP()
// → Manifold: [] ✗ → fallback: export GLB → tauConverter.exportFromGlb(glb, 'step')
```

## Diagrams

### Export Resolution Flow

```
                export(format, options)
                        │
                        ▼
              ┌─────────────────────┐
              │ Middleware Onion     │
              │ (wrapExportGeometry) │
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ kernel.supported    │
              │ ExportFormats       │──── yes ────┐
              │ includes format?    │             │
              └─────────┬───────────┘             │
                   no   │                         │
                        ▼                         ▼
              ┌─────────────────────┐   ┌─────────────────────┐
              │ Export GLB from     │   │ kernel.exportGeometry│
              │ kernel (native)     │   │ (native handle)      │
              └─────────┬───────────┘   └─────────┬───────────┘
                        │                         │
                        ▼                         │
              ┌─────────────────────┐             │
              │ Apply pre-export    │             │
              │ transforms for      │             │
              │ target format       │             │
              └─────────┬───────────┘             │
                        │                         │
                        ▼                         │
              ┌─────────────────────┐             │
              │ ExporterProvider    │             │
              │ .exportFromGlb()   │             │
              └─────────┬───────────┘             │
                        │                         │
                        ▼                         ▼
              ┌─────────────────────────────────────┐
              │ Apply post-export format conventions │
              └─────────────────┬───────────────────┘
                                │
                                ▼
                        ExportFile[]
```

## References

- Library API Policy: `docs/policy/library-api-policy.md`
- Geometry Transfer Architecture: `docs/research/geometry-data-transfer-architecture.md`
- Geometry Pipeline Copy Audit: `docs/research/geometry-pipeline-copy-audit.md`
- Runtime topology: `docs/architecture/runtime-topology.md`
- Converter package: `packages/converter/src/index.ts`
- Runtime client: `packages/runtime/src/client/runtime-client.ts`
- Kernel definition types: `packages/runtime/src/types/runtime-kernel.types.ts`
- Middleware types: `packages/runtime/src/types/runtime-middleware.types.ts`

## Appendix

### A. Current Export Entry Points Inventory

| Entry Point                             | File                                               | Pipeline                 | CU Support          | Thread |
| --------------------------------------- | -------------------------------------------------- | ------------------------ | ------------------- | ------ |
| Command palette (STL/STEP/GLTF/GLB/3MF) | `project-command-items.tsx`                        | Kernel worker (Path A)   | Main CU only        | Worker |
| Chat exporter panel                     | `chat-converter.tsx` → `Converter`                 | `exportFromGlb` (Path B) | Main CU only        | Main   |
| Preview page downloads                  | `preview-desktop/mobile.tsx` → `use-cad-export.ts` | Kernel worker (Path A)   | Main CU only        | Worker |
| AR Quick Look                           | `use-ar.ts` → `chat-viewer.tsx`                    | `exportFromGlb` (Path B) | Main CU only        | Main   |
| Hero viewer export                      | `hero-viewer.tsx` → `useGeometryExport`            | `exportFromGlb` (Path B) | N/A (single CU)     | Main   |
| Standalone converter                    | `routes/converter/route.tsx` → `Converter`         | `exportFromGlb` (Path B) | N/A (uploaded file) | Main   |

### B. Per-Kernel Native Export Format Matrix

| Kernel          | stl   | stl-binary | step       | step-assembly | glb   | gltf  | 3mf   | usdz  | obj   | fbx   |
| --------------- | ----- | ---------- | ---------- | ------------- | ----- | ----- | ----- | ----- | ----- | ----- |
| Replicad        | Yes   | Yes        | Yes (BRep) | Yes (BRep)    | Yes   | Yes   | —     | —     | —     | —     |
| OpenCascade     | Yes   | Yes        | Yes (BRep) | Yes (BRep)    | Yes   | Yes   | —     | —     | —     | —     |
| Manifold        | —     | —          | —          | —             | Yes   | Yes   | —     | —     | —     | —     |
| OpenSCAD        | Yes   | Yes        | —          | —             | Yes   | Yes   | Yes   | —     | —     | —     |
| JSCAD           | —     | —          | —          | —             | Yes   | Yes   | —     | —     | —     | —     |
| Zoo (KCL)       | Yes   | Yes        | Yes        | —             | Yes   | Yes   | —     | —     | —     | —     |
| Tau (converter) | Conv. | Conv.      | Conv.      | —             | Conv. | Conv. | Conv. | Conv. | Conv. | Conv. |

### C. Format Type Comparison

| Format String   | In `ExportFormat` | In `SupportedExportFormat` | Notes                                                 |
| --------------- | ----------------- | -------------------------- | ----------------------------------------------------- |
| `stl`           | Yes               | Yes                        | Intersection                                          |
| `stl-binary`    | Yes               | —                          | Runtime only; converter has no binary STL distinction |
| `step`          | Yes               | Yes                        | Intersection; vastly different quality (BRep vs mesh) |
| `step-assembly` | Yes               | —                          | Runtime only                                          |
| `glb`           | Yes               | Yes                        | Intersection                                          |
| `gltf`          | Yes               | Yes                        | Intersection                                          |
| `3mf`           | Yes               | —                          | Runtime only; converter uses Assimp internally        |
| `3ds`           | —                 | Yes                        | Converter only                                        |
| `dae`           | —                 | Yes                        | Converter only                                        |
| `fbx`           | —                 | Yes                        | Converter only                                        |
| `obj`           | —                 | Yes                        | Converter only                                        |
| `ply`           | —                 | Yes                        | Converter only                                        |
| `usda`          | —                 | Yes                        | Converter only                                        |
| `usdz`          | —                 | Yes                        | Converter only (critical for AR)                      |
| `x`             | —                 | Yes                        | Converter only                                        |
| `x3d`           | —                 | Yes                        | Converter only                                        |
