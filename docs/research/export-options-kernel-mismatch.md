---
title: 'Export Options Kernel Mismatch'
description: 'Investigation into why OpenSCAD-specific export options appear for replicad files in the export UI'
status: draft
created: '2026-04-10'
updated: '2026-04-10'
category: investigation
related:
  - docs/research/export-pipeline-v5.md
  - docs/research/nativehandle-serialization-and-pipeline-architecture.md
  - docs/policy/library-api-policy.md
---

# Export Options Kernel Mismatch

Investigation into why kernel-specific export options (e.g., OpenSCAD's `segments`/`minimumAngle`/`minimumSize`) appear when exporting files that use a different kernel (e.g., replicad).

## Executive Summary

The export UI displays wrong tessellation options because the `selectBestRoutes` algorithm selects routes by schema richness (most JSON Schema properties wins), not by the active kernel. This is not just a UX issue — it causes **runtime crashes**: exporting USDZ from a replicad file sends OpenSCAD-shaped options to the worker, which validates them against the replicad schema. The replicad kernel then destructures `options.tessellation.linearTolerance` from an undefined `tessellation` object, producing `Cannot destructure property 'linearTolerance' of 'options.tessellation' as it is undefined`. The fix requires surfacing `activeKernelId` to the UI layer via a dedicated `activeKernelChanged` protocol event, then replacing the schema-richness heuristic with deterministic kernel-filtered route selection.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)

## Problem Statement

When exporting a replicad file (`main.ts`), the export panel shows OpenSCAD-specific tessellation options:

- **Segments** (OpenSCAD `$fn`) — should not appear for replicad
- **Minimum Angle** (OpenSCAD `$fa`) — should not appear for replicad
- **Minimum Size** (OpenSCAD `$fs`) — should not appear for replicad

Expected behavior: replicad files should show replicad-specific tessellation (Linear Tolerance, Angular Tolerance).

Attempting to export USDZ from a replicad file crashes with:

```
Cannot destructure property 'linearTolerance' of 'options.tessellation' as it is undefined.
```

The UI sends OpenSCAD-shaped options (`{ segments, minimumAngle, minimumSize }`) which the worker validates against the replicad Zod schema. Since the replicad schema expects `{ linearTolerance, angularTolerance }`, the OpenSCAD-shaped tessellation object is stripped during validation, leaving `tessellation` as `undefined`. The replicad kernel then crashes when destructuring the missing property.

## Methodology

Source analysis across three layers:

1. **UI layer**: `chat-converter.tsx` — route selection algorithm, schema rendering, capabilities access
2. **Protocol layer**: `runtime-protocol.types.ts`, `runtime-worker-dispatcher.ts` — what data crosses the worker boundary
3. **Worker layer**: `kernel-worker.ts`, `kernel-runtime-worker.ts` — how `activeKernelId` is managed and used

## Findings

### Finding 1: `selectBestRoutes` uses schema-richness heuristic, not kernel identity

The route selection algorithm in `chat-converter.tsx` (lines 126–151) iterates all export routes in the manifest and keeps one route per target format using two tie-breaking rules:

1. Prefer `brep` fidelity over `mesh`
2. If fidelity ties, prefer the route with more JSON Schema properties

The code comment at line 118–125 states: "the active kernel's route will always have the most detailed schema for its supported formats." This assumption is **false**. Evidence:

| Format | OpenSCAD schema properties                       | Replicad schema properties                       |
| ------ | ------------------------------------------------ | ------------------------------------------------ |
| STL    | 2 (tessellation, coordinateSystem)               | 3 (binary, tessellation, coordinateSystem)       |
| GLB    | 2 (tessellation, coordinateSystem)               | 2 (tessellation, coordinateSystem)               |
| USDZ   | 2 (tessellation, coordinateSystem) via transcode | 2 (tessellation, coordinateSystem) via transcode |

For STL, replicad wins (3 > 2). For GLB and formats reached via transcoding, both kernels tie at 2 top-level properties. When counts are equal, the **first** route encountered wins (no replacement). Since OpenSCAD routes appear first in the manifest array (alphabetical kernel registration or insertion order in `buildCapabilitiesManifest`), OpenSCAD's route is kept for GLB/GLTF/USDZ and all transcoded formats.

The screenshot confirms this: STL correctly shows replicad options (Binary + Linear/Angular Tolerance), but USDZ shows OpenSCAD options (Segments, Minimum Angle, Minimum Size).

### Finding 2: `activeKernelId` exists in the worker but is never exposed to the UI

`KernelRuntimeWorker` stores `activeKernelId` as a private field (line 90), set during `ensureActiveKernel()` (line 289) when a file is first rendered. The worker uses this internally for:

- Export route filtering in `executeExportWithRoute` (line 2021): `r.kernelId === activeKernelId`
- Export schema validation in `exportGeometry` (line 928): `this.kernelExportZodSchemasMap.get(activeKernelId)`

However, `activeKernelId` never crosses the worker boundary. It is absent from:

- `CapabilitiesManifest` type (`runtime.types.ts` lines 335–340)
- `RuntimeResponse` protocol messages (`runtime-protocol.types.ts` lines 208–230)
- `RuntimeClient` public API (`runtime-client.ts`)
- `CadContext` in the UI state machine (`cad.machine.ts` line 44)

### Finding 3: The capabilities manifest is static — built once at init, never updated

`buildCapabilitiesManifest()` runs during `onInitialize` (line 531 in `kernel-worker.ts`). It enumerates ALL registered kernels and builds routes for every `(kernelId, format)` combination, plus every `(kernelId, transcoder, targetFormat)` combination. This produces 100+ routes in the manifest (as evidenced by the user's paste).

The manifest is sent once via the `initialized` protocol response (line 188–192 in `runtime-worker-dispatcher.ts`). There is no mechanism to re-emit an updated manifest when the active kernel changes.

### Finding 4: Wrong options cause runtime crashes, not just wrong UI

When the user clicks export, the worker routes the request to the active kernel (replicad) but passes options that were configured against the wrong schema (OpenSCAD). The validation flow:

1. UI sends `{ tessellation: { segments: 32, minimumAngle: 12, minimumSize: 2 } }` — OpenSCAD-shaped
2. Worker's `exportGeometry` validates against replicad's Zod schema, which expects `{ linearTolerance, angularTolerance }`
3. Zod's `strict()` validation strips the unrecognized OpenSCAD fields, or the entire `tessellation` object fails to parse
4. Replicad kernel receives `options.tessellation` as `undefined`
5. Kernel destructures: `const { linearTolerance } = options.tessellation` → **runtime crash**

Error observed: `Cannot destructure property 'linearTolerance' of 'options.tessellation' as it is undefined.`

This elevates the bug from "wrong form fields" to **export failure** — users cannot export certain formats (USDZ, GLB, GLTF, and all transcoded formats that go through GLB) when the active kernel differs from the one whose route was selected by the heuristic.

### Finding 5: `hero-viewer.tsx` has the same kernel-agnostic problem

The landing page format selector (`hero-viewer.tsx` lines 65–81) also uses `capabilities.exportRoutes` without kernel filtering — it deduplicates by first occurrence. This is a secondary instance of the same architectural gap.

### Finding 6: Dedicated `activeKernelChanged` event is strictly superior to piggybacking on `geometryComputed`

Deep analysis of two candidate approaches for communicating the active kernel to the UI — (A) a dedicated `activeKernelChanged` event vs (B) adding `kernelId` to the existing `geometryComputed` response — reveals three architectural defects in approach B that disqualify it.

**Execution order during `executeCurrentRender()`:**

```
Step 1: pushState('rendering')    → onStateChanged?.('rendering')
Step 2: getParameters()           → onParametersResolved?.()
Step 3: createGeometry()
        └→ ensureActiveKernel()   ← KERNEL SELECTED (approach A fires here)
        └→ ... computation ...    ← can take seconds
Step 4: onGeometryComputed?.()    ← geometryComputed fires here (approach B)
Step 5: pushState('idle')         → onStateChanged?.('idle')
```

**Defect 1 — Timing delay.** The gap between step 3 (kernel selected) and step 4 (geometry computed) can be seconds for complex models. If the user opens the exporter during computation, approach A already has the correct kernel identity; approach B does not. The UI would display wrong options or no options during the entire computation window.

**Defect 2 — Silent failure on render errors.** When the kernel is selected (step 3) but geometry computation throws, control jumps to the `catch` block which fires `onError` and `pushState('error')`. `onGeometryComputed` never fires. With approach B, the UI never learns the kernel identity after a failed render — the export panel shows wrong options indefinitely until a successful render occurs. Render errors are common: syntax errors, WASM crashes, user code bugs, timeouts.

**Defect 3 — No reset signal.** When `onFileChanged()` runs, it sets `activeKernelId = undefined`. Between this reset and the next successful render, the UI should know the kernel is indeterminate. Approach A emits `undefined` immediately. Approach B provides no signal — the UI retains the stale kernel ID from the previous file's kernel.

**Policy compliance comparison (`docs/policy/library-api-policy.md`):**

| Dimension            | Dedicated `activeKernelChanged` (A)                 | Piggyback on `geometryComputed` (B)                   |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| §5 Naming            | `activeKernelChanged` describes the action          | Adding `kernelId` to geometry conflates concerns      |
| §7 Subscribe-Anytime | Independent subscription for kernel identity        | Must subscribe to geometry events to learn kernel ID  |
| §11 spirit           | Required `kernelId: string \| undefined` — explicit | Optional `kernelId?` — consumers must check existence |
| §12 TypeScript-First | Clean discriminated union member                    | Optional field weakens existing union                 |
| Precedent            | Follows `stateChanged` pattern                      | No precedent for piggybacking state on data responses |
| Surface area         | New protocol message + event overload               | Minimal — extends existing response                   |

Approach B's only advantage is less surface area (no new protocol message type). This is outweighed by the three architectural defects. The `stateChanged` precedent — where worker state has its own event channel rather than being piggybacked on data responses — is the binding pattern.

### Finding 7: Schema-richness heuristic is entirely unnecessary with `activeKernelId`

The `schemaPropertyCount` heuristic solved two problems simultaneously, but only one was real:

| Problem                         | Description                                                                       | Real?                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cross-kernel disambiguation     | Pick the "right kernel's route" when manifest contains routes from all kernels    | No — a broken proxy for `activeKernelId`, which was never exposed |
| Within-kernel route tiebreaking | Pick the best route when one kernel has multiple routes to the same target format | Yes — but schema richness is the wrong signal                     |

**Cross-kernel disambiguation (the false problem).** The entire schema-richness heuristic was a proxy for "the active kernel" — but a broken one. Evidence from Finding 1 shows OpenSCAD and replicad both have 2 top-level properties for GLB/USDZ, so the proxy fails. Once `activeKernelId` is available, routes are filtered to a single kernel deterministically. No heuristic needed.

**Within-kernel tiebreaking (the real problem).** A single kernel can produce multiple routes to the same target format:

- **Direct route**: kernel natively exports that format (e.g., replicad→GLB)
- **Transcoded route**: kernel exports an intermediate format, transcoder converts (e.g., replicad→STEP→GLB via transcoder)

For this case, the architecturally correct tiebreakers are:

1. **brep > mesh** — retained from current heuristic, architecturally meaningful (BREP preserves geometric precision deeper into the pipeline)
2. **direct > transcoded** — new, replaces schema richness. Direct routes are simpler (fewer hops), faster (no transcoder overhead), and lossless (no intermediate format conversion)

Schema richness was never the right signal for within-kernel tiebreaking either. Schema differences between two same-kernel routes to the same target are driven by the transcoder's own option schema being merged in — having "more properties" does not make a route better, it just means the transcoder exposes more knobs.

**Same-fidelity, both-transcoded ties.** When two transcoded routes from the same kernel reach the same target at the same fidelity through different intermediaries (e.g., replicad→GLB→USDZ vs replicad→STEP→USDZ), first-encountered wins. This is acceptable because fidelity is the transcoder author's contract with the framework about output quality. Two same-fidelity routes to the same target from the same kernel are, by definition, interchangeable. If they are not, that is a bug in the transcoder's fidelity declaration, not in the route selection algorithm.

**Undefined kernel state.** When `activeKernelId` is `undefined` (before first render, or after `onFileChanged()` resets), `selectBestRoutes` returns an empty map. The export panel should be disabled during this window. There is no UX regression — the user cannot export without geometry, and the `activeKernelChanged` event fires at the start of `ensureActiveKernel()` (before geometry computation), so the window is brief.

The `schemaPropertyCount` helper function and its associated `schemaPropertyCount(route.schema) > schemaPropertyCount(existing.schema)` comparison can be deleted entirely.

## Recommendations

| #   | Action                                                              | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `activeKernelId` to the worker→UI protocol                      | P0       | Medium | High   |
| R2  | Replace `selectBestRoutes` heuristic with kernel-filtered selection | P0       | Low    | High   |
| R3  | Update `hero-viewer.tsx` format selector                            | P1       | Low    | Medium |
| R4  | Add test coverage for kernel-aware route selection                  | P1       | Low    | Medium |
| R5  | Delete `schemaPropertyCount` and false assumption comment           | P2       | Low    | Low    |

### R1: Surface `activeKernelId` via dedicated protocol event

Add a new `activeKernelChanged` response to the runtime protocol, emitted by the dispatcher when the active kernel changes during rendering. See Finding 6 for the full analysis of why this approach is preferred over piggybacking on `geometryComputed`.

**Policy compliance** (`docs/policy/library-api-policy.md`):

- **Section 5 — Naming**: Worker callback uses `on*` prefix (`onActiveKernelChanged`) per the framework hook naming convention. Follows existing patterns: `onStateChanged`, `onGeometryComputed`, `onParametersResolved`.
- **Section 7 — Subscribe-Anytime Events**: Client event uses `.on('activeKernelChanged', handler)` returning an unsubscribe function. Subscribable at any point in the lifecycle, compatible with React's `useEffect` cleanup.
- **Section 12 — TypeScript-First**: Protocol response uses discriminated union (`type: 'activeKernelChanged'`), consistent with the existing `RuntimeResponse` union.

**Protocol layer** (`runtime-protocol.types.ts`):

Add `activeKernelChanged` to `RuntimeResponse`:

```typescript
| { type: 'activeKernelChanged'; kernelId: string | undefined }
```

**Dispatcher** (`runtime-worker-dispatcher.ts`):

Wire the callback following the existing `onStateChanged` / `onGeometryComputed` pattern:

```typescript
worker.onActiveKernelChanged = (kernelId) => {
  respond({ type: 'activeKernelChanged', kernelId });
};
```

**Worker** (`kernel-worker.ts` / `kernel-runtime-worker.ts`):

Add `onActiveKernelChanged?: (kernelId: string | undefined) => void` callback to `KernelWorker`, following the existing `onStateChanged` / `onGeometryComputed` callback property pattern. In `KernelRuntimeWorker.ensureActiveKernel()`, after setting `this.activeKernelId`, invoke the callback. Also invoke with `undefined` in `onFileChanged()` when the kernel is reset.

**Client** (`runtime-client.ts`):

Add `on('activeKernelChanged', handler)` event overload. Store the active kernel ID on the client instance. Return unsubscribe function per Section 7.

**UI** (`cad.machine.ts`):

Add `activeKernelId?: string` to `CadContext`. Handle `activeKernelChanged` events to update it.

### R2: Replace `selectBestRoutes` with kernel-filtered deterministic selection

Replace the schema-richness heuristic with deterministic kernel-filtered route selection. See Finding 7 for the full analysis of why the `schemaPropertyCount` heuristic is eliminated.

```typescript
function selectBestRoutes(
  capabilities: CapabilitiesManifest,
  activeKernelId: string | undefined,
): Map<FileExtension, ExportRoute> {
  if (!activeKernelId) {
    return new Map();
  }

  const routes = capabilities.exportRoutes.filter((r) => r.kernelId === activeKernelId);
  const bestRoutes = new Map<FileExtension, ExportRoute>();

  for (const route of routes) {
    const existing = bestRoutes.get(route.targetFormat);
    if (!existing) {
      bestRoutes.set(route.targetFormat, route);
      continue;
    }

    // Prefer brep fidelity over mesh
    if (route.fidelity === 'brep' && existing.fidelity !== 'brep') {
      bestRoutes.set(route.targetFormat, route);
      continue;
    }
    if (existing.fidelity === 'brep' && route.fidelity !== 'brep') {
      continue;
    }

    // Prefer direct routes over transcoded (fewer hops, no conversion loss)
    if (!route.transcoderId && existing.transcoderId) {
      bestRoutes.set(route.targetFormat, route);
    }
  }

  return bestRoutes;
}
```

**Changes from current implementation:**

1. **`activeKernelId` is required** (not optional) — the function returns an empty map when undefined rather than falling back to a broken cross-kernel heuristic
2. **`direct > transcoded`** replaces `schemaPropertyCount` — architecturally meaningful tiebreaker (simpler pipeline, no conversion loss)
3. **`schemaPropertyCount` helper deleted** — no longer needed

### R3: Update `hero-viewer.tsx`

Apply the same `activeKernelId` filtering to the landing page format selector, or accept the current behavior as intentional (showing all formats from all kernels for the demo viewer).

### R4: Test coverage

Add tests in `chat-converter.test.tsx` that verify:

- When `activeKernelId` is `'replicad'`, only replicad routes are selected
- When `activeKernelId` is `'openscad'`, only OpenSCAD routes are selected
- When `activeKernelId` is `undefined`, returns empty map
- Direct routes are preferred over transcoded routes for same format/fidelity
- Brep fidelity is preferred over mesh fidelity
- OpenSCAD tessellation options never appear for replicad files

### R5: Delete `schemaPropertyCount` and false assumption comment

Delete the `schemaPropertyCount` helper function entirely. Remove the JSDoc comment claiming "the active kernel's route will always have the most detailed schema." Replace with documentation of the actual kernel-filtered selection strategy and its tiebreaking rules.

## Trade-offs

### Alternative A: Embed `activeKernelId` in `CapabilitiesManifest`

Instead of a new protocol message, add `activeKernelId?: string` to `CapabilitiesManifest` and re-emit the manifest when the kernel changes.

| Dimension   | Pro                                        | Con                                                                 |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Simplicity  | Reuses existing `capabilitiesUpdated` flow | Conflates static capabilities with dynamic state                    |
| Correctness | Works                                      | Manifest semantics change from "what's possible" to "what's active" |
| Performance | Minimal                                    | Re-emitting full manifest on every file change                      |

**Verdict**: Rejected. The manifest is a static discovery artifact. Active kernel identity is dynamic runtime state. Mixing them violates the single-responsibility principle and makes the manifest's semantics ambiguous.

### Alternative B: Piggyback `kernelId` on `geometryComputed` response

Add `kernelId` to the existing `geometryComputed` protocol response instead of introducing a new event.

| Dimension                   | Dedicated `activeKernelChanged` (R1)                            | Piggyback on `geometryComputed`                                                     |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Timing                      | Fires inside `ensureActiveKernel()` — before computation        | Fires after `onGeometryComputed` — after computation                                |
| Error resilience            | Fires even when render fails (kernel selected before error)     | Never fires on render failure — `catch` fires `onError`, skips `onGeometryComputed` |
| Reset handling              | Emits `undefined` immediately in `onFileChanged()`              | No signal — UI retains stale kernel ID until next successful render                 |
| Single responsibility       | Kernel identity is worker state, not geometry data              | Overloads geometry output with kernel selection metadata                            |
| Policy §5 Naming            | `activeKernelChanged` describes the action                      | Adding `kernelId` to a geometry event conflates concerns                            |
| Policy §7 Subscribe-Anytime | Independent subscription for kernel identity                    | Must subscribe to geometry events to learn kernel identity                          |
| Policy §11 spirit           | Required `kernelId: string \| undefined` — explicit nullability | Optional `kernelId?` — consumers must check existence                               |
| Policy §12 TypeScript-First | Clean discriminated union member                                | Optional field weakens existing union                                               |
| Precedent                   | Follows `stateChanged` — both are worker state notifications    | No precedent for piggybacking state on data responses                               |
| Surface area                | New protocol message, event overload, client field              | Minimal — extends existing response                                                 |

**Execution order during `executeCurrentRender()`:**

```
Step 1: pushState('rendering')    → onStateChanged?.('rendering')
Step 2: getParameters()           → onParametersResolved?.()
Step 3: createGeometry()
        └→ ensureActiveKernel()   ← KERNEL SELECTED (R1 fires here)
        └→ ... computation ...    ← can take seconds
Step 4: onGeometryComputed?.()    ← geometryComputed fires here
Step 5: pushState('idle')         → onStateChanged?.('idle')
```

The timing gap between steps 3 and 4 can be seconds for complex models. If the user opens the exporter during computation, R1 already has the correct kernel; Alternative B does not.

**Failure path — the disqualifying difference.** When the kernel is selected (step 3) but geometry computation fails, control jumps to the `catch` block which fires `onError` and `pushState('error')`. `onGeometryComputed` never fires. With Alternative B, the UI never learns the kernel identity after a failed render — the export panel shows wrong options indefinitely until a successful render occurs. Render errors are common (syntax errors, WASM crashes, user code bugs).

**File change → kernel reset.** When `onFileChanged()` runs, it sets `activeKernelId = undefined`. Between this reset and the next successful render, R1 emits `undefined` immediately so the UI can show indeterminate state. Alternative B provides no signal — the UI retains the stale ID from the previous file's kernel.

**Verdict**: Rejected. Alternative B's only advantage is less surface area (no new protocol message type). This is outweighed by three architectural defects: delayed timing, silent failure on render errors, and no reset signal. The `stateChanged` precedent — where worker state has its own event channel rather than being piggybacked on data responses — is the binding pattern.

### Alternative C: Pre-filter manifest in the worker

Have `buildCapabilitiesManifest` only emit routes for the active kernel.

| Dimension    | Pro                                                | Con                                                    |
| ------------ | -------------------------------------------------- | ------------------------------------------------------ |
| UI changes   | Zero — `selectBestRoutes` would "just work"        |                                                        |
| Timing       | Requires kernel to be known at manifest build time | Manifest is built at init, before any file is rendered |
| Data loss    |                                                    | UI loses visibility into other kernels' capabilities   |
| File changes |                                                    | Must rebuild + re-emit on every file change            |

**Verdict**: Rejected. The manifest is built at init time when no kernel is active. Would require deferred manifest building, adding complexity to the init flow.

### Alternative D: Retain schema-richness as fallback when `activeKernelId` is undefined

Keep the `schemaPropertyCount` heuristic as a fallback for the undefined-kernel window (before first render, after file change).

| Dimension  | Pro                                              | Con                                                                  |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Continuity | Export panel shows something before first render | Shows wrong options (the original bug)                               |
| UX         | No empty state                                   | Users might attempt export before geometry exists (will fail anyway) |
| Code       | Keeps existing code                              | Retains the broken heuristic as dead-but-reachable code              |

**Verdict**: Rejected. The user cannot export without geometry, and `activeKernelChanged` fires at the start of `ensureActiveKernel()` (before computation), so the undefined window is brief. Showing wrong options during this window is worse than showing nothing — it was the original bug. An empty map with a disabled export panel is the correct UX for "kernel not yet determined."

## Code Examples

### Current behavior (broken)

```typescript
const routes = selectBestRoutes(capabilities);
const glbRoute = routes.get('glb');
// glbRoute.kernelId === 'openscad' even for a replicad file
```

### Fixed behavior (R1 + R2)

```typescript
const routes = selectBestRoutes(capabilities, activeKernelId);
const glbRoute = routes.get('glb');
// glbRoute.kernelId === 'replicad' when editing a replicad file
// returns empty map when activeKernelId is undefined
```

## Diagrams

### Current flow (broken)

```
Worker                            UI
──────                            ──
init → buildCapabilitiesManifest
       (ALL kernels)
  ──────capabilities──────────→  CadContext.capabilities
                                  (all 100+ routes)
render → ensureActiveKernel
         activeKernelId = 'replicad'
  ──────geometryComputed──────→  (no kernel identity)

                                  User opens exporter
                                  selectBestRoutes(capabilities)
                                  → picks OpenSCAD for GLB/USDZ ✗
```

### Fixed flow (R1)

```
Worker                            UI
──────                            ──
init → buildCapabilitiesManifest
       (ALL kernels)
  ──────capabilities──────────→  CadContext.capabilities

render → ensureActiveKernel
         activeKernelId = 'replicad'
  ──────activeKernelChanged───→  CadContext.activeKernelId = 'replicad'
  ──────geometryComputed──────→

                                  User opens exporter
                                  selectBestRoutes(capabilities, 'replicad')
                                  → picks replicad for all formats ✓
```

### Error recovery (R1 vs Alternative B)

```
Worker                            UI (R1)              UI (Alt B)
──────                            ──────               ──────
render → ensureActiveKernel
         kernelId = 'replicad'
  ──activeKernelChanged────→     kernelId = 'replicad'  (no signal)
  └→ computation throws
  ──onError────────────────→     error shown             error shown
                                  export panel: replicad  export panel: STALE
```

### Route selection tiebreaking (R2)

```
Within a single kernel's routes for target format X:

  1. brep > mesh             (fidelity tiebreaker)
  2. direct > transcoded     (pipeline simplicity tiebreaker)
  3. first-encountered wins  (same-fidelity, both-transcoded)

  schemaPropertyCount: DELETED (was a broken proxy for activeKernelId)
```

## References

- `apps/ui/app/routes/projects_.$id/chat-converter.tsx` — `selectBestRoutes`, `deriveAvailableFormats`, `resolveFormatSchema`
- `packages/runtime/src/framework/kernel-worker.ts` — `buildCapabilitiesManifest`, `executeExportWithRoute`
- `packages/runtime/src/framework/kernel-runtime-worker.ts` — `ensureActiveKernel`, `getActiveKernelId`
- `packages/runtime/src/framework/runtime-worker-dispatcher.ts` — protocol dispatch
- `packages/runtime/src/client/runtime-client.ts` — `capabilities` getter, event handlers
- `packages/runtime/src/types/runtime.types.ts` — `CapabilitiesManifest`, `ExportRoute`
- `packages/runtime/src/types/runtime-protocol.types.ts` — `RuntimeCommand`, `RuntimeResponse`
- `apps/ui/app/machines/cad.machine.ts` — `CadContext`, `capabilitiesUpdated` event handling
- `apps/ui/app/routes/_index/hero-viewer.tsx` — landing page format selector
