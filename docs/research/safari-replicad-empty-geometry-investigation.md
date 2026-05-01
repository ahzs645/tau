---
title: 'Safari Replicad Empty-Geometry Investigation'
description: 'Root-cause investigation of an empty replicad viewport in Safari at the project editor route, tracing the smoking gun to a zero-length geometry array emitted by the kernel with success=true.'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
category: investigation
related:
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/replicad-occt-normal-pipeline-v3.md
  - docs/research/prod-staging-ui-deployment-status.md
---

# Safari Replicad Empty-Geometry Investigation

Root-cause investigation of an empty replicad viewport in Safari while viewing `apps/ui/app/routes/projects_.$id/route.tsx`, tracing the smoking gun through the kernel→main→GLTFLoader pipeline.

## Executive Summary

The viewport is empty because **the replicad kernel returned a zero-length `Geometry[]` array with `success: true`** (`[CadMachine] geometry event received – {success: true, dataLength: 0}` followed by `[CadMachine] setGeometries – {count: 0, file: "main.ts"}`). This short-circuits the entire downstream rendering pipeline before `GLTFLoader` is ever invoked, so the S5 `probeGltfScene` diagnostic added in `staging-cors-coep-safari-rendering-audit.md` R6 cannot fire and provides no signal for this failure mode. The smoking gun is **upstream of the GLB**: the kernel itself produced no geometries.

There are exactly two code paths in `replicad.kernel.ts` that can return `success: true` with `geometry: []`. Both are silent in the browser console (one surfaces an `info`-level kernel issue that is routed only to Monaco markers, the other has no diagnostic at all). Without a kernel-side log distinguishing the two paths, we cannot tell from the user's transcript which one fired — that observability gap is itself the highest-priority fix.

The recommendation is **R1 + R2**: add an unconditional kernel-side warning whenever `createGeometry` returns zero geometries (disambiguating "main returned nothing" from "renderOutput filtered everything") and mirror that signal as a `console.warn` in `cad.machine` when `dataLength === 0`. With those two probes in place, the next Safari run will pinpoint the exact line in 60 seconds.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: `dataLength: 0` is `Geometry[].length`, not GLB byte length](#finding-1-datalength-0-is-geometrylength-not-glb-byte-length)
  - [Finding 2: Only two code paths return `success: true` with `geometry: []`](#finding-2-only-two-code-paths-return-success-true-with-geometry-)
  - [Finding 3: Both empty-geometry paths are silent in the browser console](#finding-3-both-empty-geometry-paths-are-silent-in-the-browser-console)
  - [Finding 4: The S5 `probeGltfScene` diagnostic cannot fire here](#finding-4-the-s5-probegltfscene-diagnostic-cannot-fire-here)
  - [Finding 5: The apparent `createGeometry completed` ordering anomaly is log buffering, not a race](#finding-5-the-apparent-creategeometry-completed-ordering-anomaly-is-log-buffering-not-a-race)
  - [Finding 6: Four `Initializing kernel: replicad` lines are per-kernel-worker, not a re-init loop](#finding-6-four-initializing-kernel-replicad-lines-are-per-kernel-worker-not-a-re-init-loop)
  - [Finding 7: `sharedWorker` reuse (R8) is wired and effective](#finding-7-sharedworker-reuse-r8-is-wired-and-effective)
  - [Finding 8: `blob://nullhttp` source-map error is a Safari sourcemap quirk, not the cause](#finding-8-blobnullhttp-source-map-error-is-a-safari-sourcemap-quirk-not-the-cause)
  - [Finding 9: `Module "fs"/"path" has been externalized` warnings are a Vite stub artifact, not the cause](#finding-9-module-fspath-has-been-externalized-warnings-are-a-vite-stub-artifact-not-the-cause)
  - [Finding 10: `401` on `ingest` is unrelated telemetry rejection](#finding-10-401-on-ingest-is-unrelated-telemetry-rejection)
- [Recommendations](#recommendations)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

When opening a project in `apps/ui/app/routes/projects_.$id/route.tsx` in Safari and rendering a replicad model (`Tray (Remixed)`, single `main.ts` compute unit), the 3D viewport shows only the axis gizmo — no user geometry. Chrome renders the same model correctly. The Safari console contains no `[Error]` or `[Warning]` entries from any kernel/runtime/three layer that would normally indicate a render failure; the only signal of trouble is two adjacent `[Log]` lines:

```text
[Log] [CadMachine] geometry event received – {success: true, dataLength: 0}
[Log] [CadMachine] setGeometries – {count: 0, file: "main.ts"}
```

`dataLength: 0` had previously been read as "GLB byte length is zero", which routed the prior investigation (`staging-cors-coep-safari-rendering-audit.md` Finding 7) toward the `convertReplicadGeometriesToGltf` SLProps-normal pipeline. This investigation re-reads the same log against the actual code to settle what `dataLength` measures and where the zero originates.

## Methodology

1. Located the producer of `geometry event received` log line in `apps/ui/app/machines/cad.machine.ts` and read the surrounding handler to determine what `dataLength` actually measures.
2. Traced backward from `client.on('geometry', …)` through `runtime-worker-client.ts` → `runtime-worker-dispatcher.ts` → `kernel-worker.ts` → `replicad.kernel.ts` to enumerate every code path that can produce `KernelSuccessResult<Geometry[]>` with `data.length === 0`.
3. Read `packages/runtime/src/middleware/geometry-cache.middleware.ts` to verify the cache cannot itself emit an empty success result (it explicitly skips writing empties — line 242 — so a "false hit" is impossible).
4. Read `packages/runtime/src/kernels/replicad/utils/render-output.ts` to enumerate filtering paths inside `renderOutput`, `createBasicShapeConfig`, and `render`.
5. Re-read `apps/ui/app/machines/cad.machine.ts` `setGeometries` action to confirm whether `event.issues` is logged (it is not — only stored into the `kernelIssues` map for `useKernelDiagnostics` → Monaco markers).
6. Cross-referenced the user's transcript against `staging-cors-coep-safari-rendering-audit.md` Findings 6, 9, 10 to separate already-explained noise (worker churn, blob-source-map quirk, init repetition) from new signal.
7. Verified `apps/ui/app/hooks/use-file-manager.tsx:107-117` and `apps/ui/app/machines/file-manager.machine.ts:80,129,157-165` to confirm the R8 `sharedWorker` reuse is in effect.

## Findings

### Finding 1: `dataLength: 0` is `Geometry[].length`, not GLB byte length

The handler in `apps/ui/app/machines/cad.machine.ts:127-130` is unambiguous:

```127:130:apps/ui/app/machines/cad.machine.ts
console.log('[CadMachine] geometry event received', {
  success: result.success,
  dataLength: result.success ? result.data.length : 0,
});
```

`result` is `HashedGeometryResult = KernelResult<Geometry[]>` (`packages/runtime/src/types/runtime.types.ts:255`). On a successful result, `result.data` is `Geometry[]`, so `result.data.length` counts **how many geometries the kernel emitted** (typically one GLB + zero-or-more SVGs for replicad), **not** the byte length of any GLB blob inside them. The very next line confirms this: `setGeometries – {count: 0, file: "main.ts"}` reads `event.geometries.length` which is the same array.

This rules out the prior hypothesis (`staging-cors-coep-safari-rendering-audit.md` Finding 7, R6) that the GLB itself was empty or that `GLTFLoader` was silently dropping nodes — neither stage runs at all when the upstream array is empty.

### Finding 2: Only two code paths return `success: true` with `geometry: []`

`packages/runtime/src/kernels/replicad/replicad.kernel.ts` `createGeometry` has exactly two early-return paths that produce a zero-length geometry array with `success: true` (any other failure throws `ReplicadBuildError` and surfaces as `success: false` via `KernelResult`):

```478:495:packages/runtime/src/kernels/replicad/replicad.kernel.ts
if (shapes === undefined) {
  return {
    geometry: [],
    nativeHandle: [],
    issues: [
      {
        message: 'main() did not return any shapes. Did you forget to add a return statement?',
        location: {
          fileName: relativeFilePath,
          startLineNumber: 1,
          startColumn: 1,
        },
        type: 'runtime',
        severity: 'info',
      },
    ],
  };
}
```

```513:518:packages/runtime/src/kernels/replicad/replicad.kernel.ts
const shapes3d = renderedShapes.filter((shape): shape is GeometryReplicad => shape.format === 'replicad');
const shapes2d = renderedShapes.filter((shape): shape is GeometrySvg => shape.format === 'svg');

if (shapes3d.length === 0 && shapes2d.length === 0) {
  return { geometry: [], nativeHandle: [] };
}
```

| Path  | Trigger                                                                                                   | `result.issues` | Visibility today                                                       |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| **A** | `mainResult.value === undefined` — user `main()` returned `undefined` (or has no `default`/`main` export) | 1 info issue    | Monaco gutter marker only. Never `console.log`'d.                      |
| **B** | `renderOutput(...)` produced zero meshable + zero svgable shapes                                          | empty           | Completely silent. No console output, no Monaco marker, no UI surface. |

Path B is reachable when `main()` returns `null`, `[]`, `[null, undefined]`, a single `null`, or any value whose `inputShapes` array becomes empty after `createBasicShapeConfig`'s nullish filter (`packages/runtime/src/kernels/replicad/utils/render-output.ts:97`). Note that `renderOutput` would `throw new Error('Invalid shape')` (line 215) if a shape were neither meshable nor svgable, which would in turn be caught at `replicad.kernel.ts:532-544` and surfaced as `success: false` — so any non-thrown empty result genuinely came from the nullish-filter branch.

### Finding 3: Both empty-geometry paths are silent in the browser console

`apps/ui/app/machines/cad.machine.ts:261-281` `setGeometries` action writes `event.issues` into `context.kernelIssues` but **does not** `console.log` them:

```261:281:apps/ui/app/machines/cad.machine.ts
setGeometries: enqueueActions(({ enqueue, event, context }) => {
  assertEvent(event, 'geometryComputed');
  console.log('[CadMachine] setGeometries', { count: event.geometries.length, file: context.file?.filename });
  const currentFileName = context.file?.filename;
  enqueue.assign({
    geometries: event.geometries,
    kernelIssues({ context }) {
      if (!currentFileName) {
        return context.kernelIssues;
      }
      const newIssues = new Map(context.kernelIssues);
      if (event.issues.length > 0) {
        newIssues.set(currentFileName, event.issues);
      } else {
        newIssues.delete(currentFileName);
      }
      return newIssues;
    },
  });
  enqueue.emit({ type: 'geometryEvaluated', geometries: event.geometries });
}),
```

`kernelIssues` is consumed only by `apps/ui/app/hooks/use-kernel-diagnostics.ts:131-203`, which translates issues into Monaco markers. There is no toast, no banner, no `console.warn`, no UI affordance for an `info`-severity kernel issue when the editor is not focused on the affected file or when the marker is below the visible viewport. **From the user's perspective the kernel succeeded silently with nothing to show.**

This is the central observability gap: every empty-success result from any kernel is invisible to the console regardless of whether the kernel attached an explanatory issue.

### Finding 4: The S5 `probeGltfScene` diagnostic cannot fire here

The `probeGltfScene` warning added by S5 (in `apps/ui/app/components/geometry/graphics/three/react/gltf-mesh.tsx`) only runs after `<GltfMesh>` mounts with a non-null `gltfBytes` prop. With `setGeometries({ count: 0 })` the parent `gltf-viewer` never renders any `<GltfMesh>` instance — there is nothing for `GLTFLoader` to load and nothing to probe. The S5 fix is correct for its targeted scenario (Gate 2/3: `GLTFLoader` returned a scene with zero children or non-finite bbox) but does not cover Gate 1 (kernel emitted zero geometries), which is what we have here.

### Finding 5: The apparent `createGeometry completed` ordering anomaly is log buffering, not a race

The transcript shows `createGeometry completed` (`packages/runtime/src/framework/kernel-worker.ts:890`) appearing **after** `geometry event received` and `setGeometries` on the main thread, which contradicts the source — `createGeometry` returns before `onGeometryComputed` is invoked at `kernel-worker.ts:1702`. The reordering is an artifact of two separate channels:

| Channel        | Mechanism                                                           | Latency to main thread           |
| -------------- | ------------------------------------------------------------------- | -------------------------------- |
| Kernel logger  | Buffered + flushed via `flushTelemetry`/`logFlushDebounceMs`        | Tens of milliseconds (debounced) |
| Geometry event | Direct `postMessage` envelope from worker → `runtime-worker-client` | Microtask-bounded                |

`onGeometryComputed?.(result)` posts the geometry envelope on the synchronous tick after `createGeometry` returns, while the `createGeometry completed` log entry sits in the per-worker batch until the next debounce flush. The ordering inversion is therefore expected and **not a clue** — the same pattern is documented in `staging-cors-coep-safari-rendering-audit.md` (lines 425-431) for the prior session.

### Finding 6: Four `Initializing kernel: replicad` lines are per-kernel-worker, not a re-init loop

`packages/runtime/src/framework/kernel-runtime-worker.ts:332` already runs at `logger.trace`, but the per-kernel-worker logger emits trace via `console.debug` on the main thread, which is why each `LoadedKernel.initialize` call reads as `[Debug]` in Safari's console. With the editor route mounting two `cad.machine` instances (one editor preview + one chat-viewer preview, see `apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx` and `chat-viewer.tsx`) and each instance owning a runtime client whose worker eagerly loads both `replicad` and `opencascade` kernels (the converter transcoder edges from the active manifest), the 4 init lines correspond to 2 workers × 2 kernel modules. This matches `staging-cors-coep-safari-rendering-audit.md` Finding 10 verbatim and is not the smoking gun.

### Finding 7: `sharedWorker` reuse (R8) is wired and effective

The transcript shows two of the three `connectWorkerActor: start` blocks logging `filePool SAB inherited from parent`, which means `apps/ui/app/machines/file-manager.machine.ts:157-165` is taking the inherit branch and `context.sharedWorker` is populated. `apps/ui/app/hooks/use-file-manager.tsx:107-117` correctly threads `parentWorker`/`parentFilePoolBuffer` into the per-CU `fileManagerMachine` input. **R8 from `staging-cors-coep-safari-rendering-audit.md` is in production and behaving correctly** — there is no per-CU SAB allocation regression to chase.

### Finding 8: `blob://nullhttp` source-map error is a Safari sourcemap quirk, not the cause

```text
[Error] Not allowed to load local resource: blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map
```

The malformed URL (`blob://nullhttp//…`) comes from Safari's WebKit-side `URL` parser when it tries to resolve the `//# sourceMappingURL=…` directive embedded in the inline `image-bitmap-data-url-worker.js` blob that Three.js's `GLTFLoader` instantiates via `URL.createObjectURL(new Blob(…))`. WebKit prepends `null` for the blob origin and concatenates the host part incorrectly only when the blob script's source map is referenced — Chrome handles the same blob URL without issue. The worker JS itself loads and runs (otherwise embedded textures would fail too); only the source map is lost, which is purely a debug-experience nuisance. This matches `staging-cors-coep-safari-rendering-audit.md` Finding 9 and is **orthogonal** to the empty-geometry bug, which fires before any GLB ever reaches `GLTFLoader`.

### Finding 9: `Module "fs"/"path" has been externalized` warnings are a Vite stub artifact, not the cause

The 16 `fs`/`path` externalized warnings appear during user-code bundle execution in the kernel worker (between `connecting client...` and `connected successfully`). They originate from Vite's browser-external stub, which warns whenever any property — including `then` — is accessed on the stub object. `await import('fs')` triggers a `then` access during Promise resolution, producing one warning per dynamic import of a Node-only module reached transitively from the bundled user code or `replicad-opencascadejs`'s source-map loader (`packages/runtime/src/kernels/replicad/replicad.kernel.ts:380-391`). The stub returns `undefined` for the access and `await` proceeds with the module namespace as the resolved value; subsequent calls into `fs.readFileSync` would throw `is not a function` and be caught upstream as `success: false`. Since the user sees `success: true`, these stubs were not exercised in a failing call path. The warnings appear identically in Chrome and are **not Safari-specific**, so they cannot explain the Safari-only divergence.

### Finding 10: `401` on `ingest` is unrelated telemetry rejection

```text
[Error] Failed to load resource: the server responded with a status of 401 (Unauthorized) (ingest, line 0)
```

This is the API rejecting an unauthenticated POST to `/v1/telemetry/ingest`. It happens because the user's session cookie has not been established at that point (the WebSocket connection above also fails with `WebSocket is closed before the connection is established`). It has no causal connection to the kernel returning zero geometries — the kernel computes locally in the worker without contacting the API.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                               | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | In `apps/ui/app/machines/cad.machine.ts:127-130`, escalate the `geometry event received` log to `console.warn` and include `issues.length` + first-issue message when `dataLength === 0`. Single-line diff; immediately surfaces both Path A and Path B in the console without changing UI behavior.                 | **P0**   | XS     | High   |
| R2  | In `packages/runtime/src/kernels/replicad/replicad.kernel.ts:478` and `516`, add a `runtime.logger.warn` at each empty-success return that names the path (`main-returned-undefined` vs `render-output-filtered-empty`) and includes the user's `relativeFilePath`. Disambiguates Path A/B in the worker transcript. | **P0**   | XS     | High   |
| R3  | Add a UI surface (toast or status-bar pill) for `info`-severity kernel issues on the active file, so "main() did not return any shapes" is not invisible when Monaco is offscreen or pointed at a different file. Reuse the existing `useKernelDiagnostics` selector.                                                | P1       | S      | Med    |
| R4  | Augment `setGeometries` (`apps/ui/app/machines/cad.machine.ts:261-281`) to `console.warn` when `event.geometries.length === 0` and `event.issues.length === 0` simultaneously — the truly silent case (Path B). Mirrors R1 but at the machine boundary and survives even if R1 is reverted.                          | P1       | XS     | Med    |
| R5  | Once R1+R2 are deployed, ask the user to re-run the failing Safari session and capture the new transcript. The path identifier in R2 + the issue message in R1 will name the exact upstream cause (user-code bundle, runMain, or renderOutput filter) without further code changes.                                  | P1       | XS     | High   |
| R6  | Generalise the gate to all kernels: `KernelWorker.executeRender` (`packages/runtime/src/framework/kernel-worker.ts:1659-1702`) is in the framework, not in `replicad.kernel.ts`. Adding a `logger.warn` there for `result.success && result.data.length === 0` covers OpenSCAD/JSCAD/Manifold/KCL with one change.   | P2       | S      | Med    |
| R7  | Reclassify `staging-cors-coep-safari-rendering-audit.md` R6 (`probeGltfScene`) as **necessary but insufficient**: it covers Gates 2/3 (loader produced empty scene) but explicitly not Gate 1 (kernel produced no geometries). Add a back-reference from R6 to this document so future debuggers don't repeat this.  | P2       | XS     | Low    |
| R8  | Defer any work on the `blob://nullhttp` Safari source-map error — it is a WebKit cosmetic regression unrelated to functional rendering. If the `image-bitmap-data-url-worker.js.map` continues to be a console-noise complaint, suppress the inline `//# sourceMappingURL=…` directive in the GLTFLoader fork.       | P3       | XS     | Low    |

**R1 + R2 are the only changes needed to get a definitive root cause.** Everything else is hygiene that will pay off the next time the same class of bug appears.

## Trade-offs

### Should `setGeometries` of `count: 0` be treated as an error state?

| Option                                                                           | Pros                                                                                                                        | Cons                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep `success: true` for empty results (status quo)                              | Distinguishes "user code is intentionally empty" from "kernel crashed"; lets `info` issues stay non-blocking in the gutter. | Silent in the console; UI appears stuck; debugging requires the user to look at the Monaco gutter or to know about `useKernelDiagnostics`.                                                                                                       |
| Promote `count: 0` to `success: false` in the framework                          | Forces a hard error UX; can't be missed.                                                                                    | Breaks the legitimate "user is iterating, hasn't returned anything yet" path; would also break tests that assert `success: true` with empty geometry. Off-policy with `runtime-architecture-policy.md` ("kernels report status; UI decides UX"). |
| **Keep `success: true`, add structured logging at framework + machine + kernel** | Preserves semantic correctness, closes the observability gap, costs ~10 lines of code total.                                | None substantive — three small additive logs in three layers (R1, R2, R6).                                                                                                                                                                       |

The third row is what R1/R2/R6 implement.

## Code Examples

### R1 patch (single-line escalation)

```typescript
// apps/ui/app/machines/cad.machine.ts:126-140 (proposed)
client.on('geometry', (result: HashedGeometryResult) => {
  const success = result.success;
  const dataLength = success ? result.data.length : 0;
  const issuesLength = success ? result.issues.length : result.issues.length;
  const log = success && dataLength === 0 ? console.warn : console.log;
  log('[CadMachine] geometry event received', {
    success,
    dataLength,
    issuesLength,
    firstIssue: success && dataLength === 0 ? result.issues[0]?.message : undefined,
  });
  ...
})
```

### R2 patch (kernel-side path naming)

```typescript
// packages/runtime/src/kernels/replicad/replicad.kernel.ts:478 (proposed)
if (shapes === undefined) {
  runtime.logger.warn('createGeometry returning empty: main-returned-undefined', {
    data: { filePath: relativeFilePath },
  });
  return {
    geometry: [],
    nativeHandle: [],
    issues: [
      /* existing info issue */
    ],
  };
}

// :516
if (shapes3d.length === 0 && shapes2d.length === 0) {
  runtime.logger.warn('createGeometry returning empty: render-output-filtered-empty', {
    data: { filePath: relativeFilePath, rawShapeCount: Array.isArray(shapes) ? shapes.length : 1 },
  });
  return { geometry: [], nativeHandle: [] };
}
```

### R6 patch (framework-level gate, kernel-agnostic)

```typescript
// packages/runtime/src/framework/kernel-worker.ts:1696-1702 (proposed)
const result = await renderWork();
if (result.success && result.data.length === 0) {
  this.logger.warn('Render produced zero geometries', {
    data: { file: this.currentFile?.filename, issuesLength: result.issues.length },
  });
}
this.pushProgress(100);
this.onProgress = undefined;
renderSpan.end();
this.flushTelemetry();
this.onGeometryComputed?.(result);
```

## Diagrams

```text
                  user opens project route in Safari
                                    │
                                    ▼
            ┌────────────────────────────────────────────┐
            │ cad.machine spawns runtime client          │
            │ kernel worker initialises replicad + OCJS  │
            │ getParameters(main.ts)  ✓  cache hit       │
            └────────────────────┬───────────────────────┘
                                 │
                                 ▼
              createGeometry(main.ts, parameters, options)
                                 │
            ┌────────────────────┴───────────────────────┐
            │ bundle(main.ts)                            │
            │ execute(bundle)                            │
            │ runMain → mainResult.value                 │
            └────────────────────┬───────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
  shapes === undefined   renderOutput → []         renderOutput → [n]
  PATH A                  PATH B                    happy path
  geometry: []            geometry: []              geometry: [glb, …]
  issues: [info]          issues: []                issues: []
        │                        │                        │
        └─────────┬──────────────┘                        │
                  │                                       │
                  ▼                                       ▼
        success: true, data.length === 0      success: true, data.length >= 1
                  │                                       │
                  ▼                                       ▼
        cad.machine: setGeometries({count: 0})  cad.machine: setGeometries({count: N})
                  │                                       │
                  ▼                                       ▼
        SILENT — viewport empty                 GltfMesh mounts → probeGltfScene
                                                runs Gates 2/3 (S5)
```

The boxed branches A and B are the smoking-gun candidates for this Safari session. Both terminate at "SILENT — viewport empty" today; R1/R2 add a console.warn at every node downstream of the branching point.

## References

- Source: `apps/ui/app/machines/cad.machine.ts:127-130, 261-281`
- Source: `packages/runtime/src/kernels/replicad/replicad.kernel.ts:439-545`
- Source: `packages/runtime/src/kernels/replicad/utils/render-output.ts:84-118, 201-243`
- Source: `packages/runtime/src/framework/kernel-worker.ts:776-895, 1659-1703`
- Source: `packages/runtime/src/middleware/geometry-cache.middleware.ts:214-269`
- Source: `apps/ui/app/hooks/use-kernel-diagnostics.ts:131-203`
- Source: `apps/ui/app/components/geometry/graphics/three/react/gltf-mesh.tsx` (S5 `probeGltfScene`)
- Related: `docs/research/staging-cors-coep-safari-rendering-audit.md` (Findings 6, 7, 9, 10; R6, R8)
- Related: `docs/research/replicad-occt-normal-pipeline-v3.md` (the SLProps-normal pipeline that R6 targeted)
- Related: `docs/research/prod-staging-ui-deployment-status.md` (S5 completion entry — to be cross-referenced from R7 above)
- WebKit blob URL parsing — observed empirically; relevant background in [WebKit bug 235395 — `URL.createObjectURL` source map resolution](https://bugs.webkit.org/show_bug.cgi?id=235395) (open as of writing).
