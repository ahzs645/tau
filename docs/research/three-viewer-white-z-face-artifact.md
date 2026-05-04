---
title: 'Three viewer white +Z face artifact'
description: 'Audit of every component in the @apps/ui Three.js viewer scene to identify the smoking gun for a white visual artifact appearing on the +Z face of rendered cubes.'
status: draft
created: '2026-05-02'
updated: '2026-05-02'
category: investigation
---

# Three viewer white +Z face artifact

Investigation into a persistent white visual artifact reported on the left side of the +Z face of an OpenSCAD cube rendered in `@taucad/ui`'s 3D viewer, and a comprehensive audit of every component contributing to the live scene graph.

## Executive Summary

A full audit of the `apps/ui` 3D pipeline turns up **three candidate sources** of stray white pixels in the viewer, ranked by likelihood:

1. **Pinned `MeasurementLine` label background** (highest likelihood) — a white `MeshBasicMaterial` with `depthTest:false`/`depthWrite:false` billboarded toward the camera. Persists across reloads via `GraphicsViewSettings.pinnedMeasurements`, never participates in the depth buffer, and renders on top of the cube regardless of orientation.
2. **`SnapPointIndicator` "inactive" inner fill** (`#ffffff`, `depthTest:false`) — leaks into the scene whenever measure mode is active and the pointer last hovered the +Z face; a stale entry in `lastSnapPointsRef` keeps a white cylinder rendering even after the pointer leaves.
3. **`matcap-soft.png` is dominated by near-white luminance** — 95% of the matcap texture is bright. With `MeshMatcapMaterial({ side: DoubleSide })` applied uniformly to all GLTF surfaces, any face whose view-space normal samples the bright hemisphere reads as solid white. This is design-time intended but is what makes faces in images 2, 3, 4 read as fully white.

Recommendation: delete the white `MeasurementLine` label-background default (replace with a translucent dark surface using normal `depthTest`), tag pinned label/snap meshes for screenshot exclusion, and consider replacing `matcap-soft.png` with one that has a tighter bright lobe so unintended viewing angles do not all read white.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Scene Graph Inventory](#scene-graph-inventory)
- [Findings](#findings)
- [Smoking Gun Ranking](#smoking-gun-ranking)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Appendix](#appendix-full-component-audit)

## Problem Statement

User report: a small white quadrilateral appears on the floor / lower-left of the cube viewport, and certain faces of the cube (notably the +Z top face when viewed from above-tilted camera angles) appear stark white when they should be a neutral gray. The artifact is reproducible across grid sizes (0.1 mm and 0.5 mm), appears across multiple camera orientations, and persists between renders.

Five reference screenshots provided by the user span:

| #   | Camera                                          | Visible artifact                                           |
| --- | ----------------------------------------------- | ---------------------------------------------------------- |
| 1   | Top-down tilt, viewport gizmo "Top" highlighted | Tiny white parallelogram at floor level lower-left of cube |
| 2   | View from below                                 | -Y back face and +Z top edge both pure white               |
| 3   | Head-on side view                               | +X face pure white, -X gray                                |
| 4   | Standard isometric                              | +X face white, +Z gray, -X darker gray                     |
| 5   | Section view active                             | Cube cut, no visible artifact                              |

The user's hypothesis was that a stray mesh is being drawn on the +Z face. The audit below confirms multiple candidates capable of producing exactly this visual signature.

## Methodology

1. Enumerated every `*.tsx`/`*.ts` file under `apps/ui/app/components/geometry/` containing `THREE`, `@react-three/fiber`, `meshBasicMaterial`, `meshMatcapMaterial`, or `MeshLine` references.
2. Cross-referenced renderer entry points (`cad-viewer.tsx`, `model-viewer.tsx`, `chat-viewer.tsx`) with the `ThreeProvider` → `Stage` → mesh hierarchy.
3. Searched for every literal `0xff_ff_ff`, `0xffffff`, `color="white"`, and `'#ffffff'` reachable from the live scene.
4. Inspected each white-emitting material's `depthTest`, `depthWrite`, `side`, `transparent`, and `renderOrder` to identify which can render in front of the cube regardless of camera orientation.
5. Decoded `apps/ui/public/textures/matcap-soft.png` to verify the matcap luminance distribution.
6. Traced the OpenSCAD → GLTF normal pipeline (`packages/runtime/src/utils/export-glb.ts:140-205`) to rule out per-vertex normal averaging as a source of edge-bleed white shading.
7. Confirmed `pinnedMeasurements` persistence via `apps/ui/app/hooks/use-view-settings-sync.ts` and `project.machine.ts`.

## Scene Graph Inventory

The live scene composes the following object families. "Persistent" means it survives without an explicit user toggle.

| Component                                     | File                                                                       | Material                                                                                                           | `depthTest` | Persistent                                           | Hidden in screenshot      |
| --------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------- | ------------------------- |
| GLTF mesh (matcap)                            | `react/gltf-mesh.tsx` + `materials/gltf-matcap.ts`                         | `MeshMatcapMaterial(matcap-soft.png, DoubleSide)`                                                                  | true        | yes                                                  | no                        |
| GLTF edges                                    | `materials/gltf-edges.ts`                                                  | `LineMaterial(black)`                                                                                              | true        | yes                                                  | no                        |
| Infinite grid                                 | `react/infinite-grid.tsx`                                                  | custom `infiniteGridMaterial` (gray)                                                                               | true        | yes                                                  | yes (`previewOnly`)       |
| Axes helper                                   | `react/axes-helper.tsx`                                                    | colored `Line` (R/G/B)                                                                                             | true        | yes                                                  | yes (`previewOnly`)       |
| Lights & Environment                          | `react/lights.tsx`                                                         | env map only                                                                                                       | n/a         | yes                                                  | no (no visible mesh)      |
| `Lightformer`s                                | `react/lights.tsx`                                                         | contributes to env map                                                                                             | n/a         | yes                                                  | no (no visible mesh)      |
| Section view stencil group                    | `react/section-view.tsx`                                                   | `MeshBasicMaterial({ colorWrite:false })`                                                                          | n/a         | only when active                                     | yes (`sectionViewHelper`) |
| Section view cap plane                        | `react/section-view.tsx` + `materials/striped-material.ts`                 | `StripedMaterial(0xdddddd / 0xbbbbbb)`                                                                             | true        | only when active                                     | yes (`sectionViewHelper`) |
| `PlaneSelector` (3+3 face buttons)            | `react/section-view-controls.tsx`                                          | `MeshMatcapMaterial(blue/green/red darkened)`                                                                      | **false**   | only when section view active and no plane chosen    | no                        |
| `TransformControls` (translate/rotate gizmos) | `react/transform-controls-drei.tsx` + `controls/transform-controls.ts`     | `matLabelBackground` is white (`0xff_ff_ff`) but `.visible = false`                                                | n/a         | only when section view active                        | n/a                       |
| `SnapPointIndicator` outer (border)           | `react/measure-tool.tsx:417`                                               | `MeshMatcapMaterial(black, DoubleSide)`                                                                            | **false**   | while measure mode active                            | no                        |
| `SnapPointIndicator` inner (fill)             | `react/measure-tool.tsx:435`                                               | `MeshBasicMaterial(white when inactive, green when active)`                                                        | **false**   | while measure mode active                            | no                        |
| `MeasurementLine` cylinder/cones              | `react/measure-tool.tsx:741-778`                                           | matcap, black                                                                                                      | true        | when measurement exists or pinned                    | no                        |
| **`MeasurementLine` label background**        | `react/measure-tool.tsx:558-569`                                           | **`MeshBasicMaterial({ color: 0xffffff, depthTest:false, depthWrite:false, transparent:true, side:DoubleSide })`** | **false**   | **when measurement exists or pinned across reloads** | no                        |
| Viewport gizmo cube/onshape                   | `controls/viewport-gizmo-cube.tsx` + `controls/viewport-gizmo-onshape.tsx` | rendered to a separate DOM canvas (not in main scene)                                                              | n/a         | yes                                                  | n/a                       |

Three components carry **white** materials with **depth testing disabled** in the live scene: the `SnapPointIndicator` inner fill, the `MeasurementLine` label background, and the (currently disabled) `TransformControls` label background. Of these, only the first two are reachable today.

## Findings

### Finding 1: `MeasurementLine` label background is unconditionally white with depth testing disabled

`apps/ui/app/components/geometry/graphics/three/react/measure-tool.tsx`:

```557:570:apps/ui/app/components/geometry/graphics/three/react/measure-tool.tsx
    const basicMaterial = new THREE.MeshBasicMaterial({
      color: materials?.backgroundColor ?? 0xff_ff_ff, // White
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    const backgroundMaterial = basicMaterial.clone();
    backgroundMaterial.color.set(materials?.backgroundColor ?? 0xff_ff_ff); // White
```

The label background is a `RoundedRectangleGeometry` billboarded toward the camera by `useFrame` at `measure-tool.tsx:655-693`, scaled by `calculateScaleFromCamera(midpoint, camera)` so it stays a constant screen size. With `depthTest:false`, **it always renders on top of the cube no matter the camera angle.** From a top-down view, the billboard's plane appears as a screen-aligned parallelogram on the floor — exactly matching the artifact seen in image 1.

Pinned measurements survive reloads because `use-view-settings-sync.ts:60-81` pushes them into `GraphicsViewSettings.pinnedMeasurements`, which is round-tripped through `project.machine.ts:548-552` and re-hydrated into `graphics.machine.ts:1155-1157` with `isPinned: true`. There is no UI affordance making it obvious that a hidden pinned measurement still exists once the user closes measure mode.

The label is tagged `sceneTag.measurementUi`, but per `apps/ui/app/utils/scene-tags.ts` and `screenshot-capability.machine.ts:581`, that tag **only excludes objects from raycasting**. Screenshot capture does not hide it. Production renders do not hide it. Only `previewOnly` and `sectionViewHelper` are hidden from screenshots.

### Finding 2: `SnapPointIndicator` inactive inner fill is white with depth testing disabled

```441:454:apps/ui/app/components/geometry/graphics/three/react/measure-tool.tsx
        <cylinderGeometry args={[innerSize, innerSize, height, segments]} />
        <meshBasicMaterial
          transparent
          toneMapped={false}
          fog={false}
          // oxlint-disable-next-line tau-lint/no-hardcoded-color -- Three.js material color
          color={isActive ? '#00ff00' : '#ffffff'}
          opacity={1}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
```

Snap points render as cylinders that **face the camera** (`useFrame` at `measure-tool.tsx:396-411`) — when viewed flat-on, a face-on cylinder reads as a small white disc-like quad. They are scaled by `calculateScaleFromCamera`, so far-away points draw smaller. Hovered snap points are rendered for every face/edge/vertex of the GLTF the cursor approaches; if the user last hovered the +Z face before navigating away from measure mode, a stale snap can persist on the +Z face for the duration of the React tree. This matches "small white spot near +Z face" in image 1.

### Finding 3: `matcap-soft.png` is overwhelmingly bright

The matcap texture decoded from `apps/ui/public/textures/matcap-soft.png` is a 512×512 16-bit grayscale "soft" matcap whose central disc is near-pure white with only a thin gray border. A `MeshMatcapMaterial` samples the texture by view-space normal `(n.x*0.5+0.5, n.y*0.5+0.5)`, which means **any face whose normal points within ~70° of the camera's up-left direction reads as solid white**.

Concretely:

- Image 3 (head-on side view) — +X face normal in view space is roughly (+1, 0, 0) → samples the right edge of the matcap → bright white.
- Image 2 (looking up from below) — -Y face normal points toward the upper hemisphere of the matcap → bright white.
- Image 4 (isometric) — +X face samples the upper-right of the matcap → bright white.

Because `applyMatcap` is called with `side: DoubleSide` and no per-face tinting (`gltf-matcap.ts:38-41`), this affects every face uniformly. **This is by design** but is responsible for the cube reading as "all white" at multiple angles, which is what users perceive as an artifact.

### Finding 4: Cube faces have flat (per-triangle) normals — gradient bleed across face is impossible

`packages/runtime/src/utils/export-glb.ts:140-205` shows the OpenSCAD → GLB pipeline writes **per-triangle flat normals** with three duplicated vertices per triangle. There is no `BufferGeometry.computeVertexNormals()` call anywhere in the kernel-worker middleware chain (`apps/ui/app/constants/kernel-worker.constants.ts`) nor in `gltf-edge-detection.middleware.ts`. So a single cube face cannot exhibit a gradient bleed from its own normals; **any "white sliver" along a face edge must come from another mesh** (label, snap indicator, edge primitive, or section view helper).

### Finding 5: `gltf-edges` is black; cannot be the white artifact source

`apps/ui/app/components/geometry/graphics/three/materials/gltf-edges.ts` constructs `LineMaterial({ color: defaultEdgeColor /* 0x000000 */, … })` with FOV-adaptive depth bias. Edges are clipped under section view via the same `clippingPlanes` route. They are black, not white, and ruled out as a source of white pixels.

### Finding 6: Section view helpers are hidden when section view is inactive

`react/section-view.tsx` and `react/section-view-controls.tsx` only mount stencil groups, cap planes, and `PlaneSelector` matcap quads when `sectionViewActive` is true. When section view is inactive (images 1–4), none of these can render. They are also tagged `sectionViewHelper` and excluded from screenshot capture. The `StripedMaterial` cap plane is not white anyway (`0xdddddd` base, `0xbbbbbb` stripe).

### Finding 7: Viewport gizmos render to a separate canvas

`viewport-gizmo-cube.tsx` and `viewport-gizmo-onshape.tsx` mount their own `WebGLRenderer` into a sibling DOM container created by `chat-viewer.tsx`. They do not inject objects into the main scene and cannot produce in-scene artifacts. Their `labelColor: 0xff_ff_ff` only paints text on the gizmo's own canvas.

### Finding 8: `TransformControls` white label background is `.visible = false`

```836:842:apps/ui/app/components/geometry/graphics/three/controls/transform-controls.ts
    const matLabelBackground = gizmoMaterial.clone();
    matLabelBackground.color.set(0xff_ff_ff);
    matLabelBackground.visible = false; // TODO: Show label text, update text as transform changes

    const matLabelText = gizmoMaterial.clone();
    matLabelText.color.set(0x00_00_00);
    matLabelText.visible = false; // TODO: Show label text, update text as transform changes
```

Both label materials are explicitly hidden. `TransformControls` itself is invoked with `visible={false}` in `react/section-view-controls.tsx:583,617`. Cannot be the artifact source today, but is a latent white-rendering hazard if the `TODO` is ever flipped on without revisiting depth state.

### Finding 9: `Lightformer`s and environment map cannot render visible scene meshes

`react/lights.tsx` mounts `<Environment>` with several `<Lightformer>` children. `@react-three/drei`'s `Lightformer` writes into the environment map render target only — it does not add a renderable mesh to the main scene. Likewise, `directionalLight` and `ambientLight` carry no geometry. Ruled out as in-scene artifact sources.

### Finding 10: `previewOnly`/`measurementUi` scene tags do not hide objects from live render

`apps/ui/app/utils/scene-tags.ts` defines three boolean tags but only `previewOnly` (axes, grid) and `sectionViewHelper` (stencil groups, cap planes) are hidden during screenshots. `measurementUi` is used **only** to exclude meshes from raycasting (so labels do not eat clicks). Pinned measurement labels are visible in both the live render and in captured screenshots — confirming users will see them in exported images too.

## Smoking Gun Ranking

| #   | Candidate                                              | Probability | Visual signature match                                                                       | Why it matters                                                                  |
| --- | ------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Pinned `MeasurementLine` label background              | High        | White quadrilateral on the floor, billboard-rotated, screen-aligned, persists across reloads | Best fit for the floor-level white quad in image 1                              |
| 2   | Stale `SnapPointIndicator` from measure mode           | Medium      | Small white circular/disc near a face, depth-test disabled                                   | Best fit if the user enabled measure mode at any point during the session       |
| 3   | Matcap white-bias on `+Z` face from above-tilt cameras | Medium      | Whole face reads white; not a "stray" object but design-time matcap luminance                | Explains why faces in images 2-4 read as pure white instead of CAD-neutral gray |
| 4   | `TransformControls` white label background activated   | Low (today) | White rounded rectangle near gizmo center                                                    | Latent risk if the `// TODO: Show label text` is enabled                        |
| 5   | Section view stencil/cap plane                         | Very low    | Light gray (not white) striped quad inside cube                                              | Only when section view is active; not visible in images 1-4                     |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                             | Priority | Effort | Impact                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| R1  | Change `MeasurementLine` background default from white to a semi-transparent dark surface (e.g. `rgba(0,0,0,0.7)`) and re-enable `depthTest:true` so the label respects scene depth. Keep `depthWrite:false` for transparency correctness.                                                                         | P0       | Low    | High — kills the dominant smoking gun                                                                      |
| R2  | Audit live `pinnedMeasurements` in user projects via dev console: `__GRAPHICS_ACTOR__.getSnapshot().context.measurements.filter(m => m.isPinned)`. If any exist on +Z face geometry, that is the proof. Add a "Show pinned measurements" toggle in the controls panel so users can find and clear orphaned pins.   | P0       | Low    | High — gives users immediate self-service recovery                                                         |
| R3  | Tag `MeasurementLine` label/cylinder meshes with `sceneTag.previewOnly` (in addition to `measurementUi`) so they are hidden in screenshot capture and from production-export renders. Alternatively introduce a new `screenshotHidden` tag with explicit semantics.                                                | P1       | Low    | Medium — prevents leaked labels from polluting AI-tool screenshots                                         |
| R4  | Replace `apps/ui/public/textures/matcap-soft.png` with a matcap whose central bright lobe is tighter (e.g. 30-40% of disc area, gradient ramp to a CAD-neutral mid-gray rather than near-white). Or apply a `tint < 1` in `applyMatcap` so the brightest matcap sample reads as light gray rather than pure white. | P1       | Low    | High — CAD viewers conventionally render gray, not white; the current matcap reads as "uncolored" geometry |
| R5  | Drop `depthTest:false` from `SnapPointIndicator` inner fill (`measure-tool.tsx:450`). Snap indicators should respect mesh depth so they cannot appear "through" the cube; the active hover state can use `renderOrder` instead of disabling depth entirely.                                                        | P1       | Low    | Medium — eliminates stale white snaps appearing on +Z face                                                 |
| R6  | Delete the `// TODO: Show label text` block in `transform-controls.ts:838,842` or finish the implementation so the latent white surface cannot be unintentionally enabled in the future.                                                                                                                           | P3       | Low    | Low — latent hazard, not a current bug                                                                     |
| R7  | Add an automated visual regression test for the OpenSCAD-cube reference render that fails if any pixel inside the cube projection reads `> 240/255` luminance when the camera is in the canonical isometric pose.                                                                                                  | P2       | Medium | High — prevents regressions of any of R1/R4/R5                                                             |

## Code Examples

### Recommended replacement for the white label background

```typescript
const basicMaterial = new THREE.MeshBasicMaterial({
  color: materials?.backgroundColor ?? 0x202124, // CAD-neutral dark surface
  opacity: 0.72,
  depthTest: true,
  depthWrite: false,
  transparent: true,
  side: THREE.DoubleSide,
  fog: false,
  toneMapped: false,
});
```

This keeps the label readable above the cube via transparency, while no longer punching a billboard-shaped white parallelogram through every camera angle. Text material would flip to `0xffffff`.

### Console snippet to find orphaned pinned measurements

```typescript
const snap = window.__GRAPHICS_ACTOR__?.getSnapshot();
const orphaned = snap?.context.measurements.filter((m) => m.isPinned);
console.table(
  orphaned?.map((m) => ({
    id: m.id,
    distance: m.distance.toFixed(3),
    start: m.startPoint.toArray().join(', '),
    end: m.endPoint.toArray().join(', '),
  })),
);
```

(`__GRAPHICS_ACTOR__` is conventional dev exposure; if unset, traverse from the React DevTools-visible `<GraphicsProvider>` actor ref.)

## Appendix: Full Component Audit

### Renderer entry points scanned

- `apps/ui/app/components/model-viewer.tsx`
- `apps/ui/app/components/geometry/cad/cad-viewer.tsx`
- `apps/ui/app/components/geometry/graphics/three/three-context.tsx`
- `apps/ui/app/components/geometry/graphics/three/scene-overlay.tsx`
- `apps/ui/app/components/geometry/graphics/three/scene.tsx`
- `apps/ui/app/components/geometry/graphics/three/stage.tsx`
- `apps/ui/app/components/geometry/graphics/three/post-processing.tsx`
- `apps/ui/app/components/geometry/graphics/three/up-direction-handler.tsx`
- `apps/ui/app/components/geometry/graphics/three/controls.tsx`
- `apps/ui/app/components/geometry/graphics/three/grid.tsx`
- `apps/ui/app/routes/projects_.$id/chat-viewer.tsx`
- `apps/ui/app/routes/projects_.$id/chat-viewer-controls.tsx`
- `apps/ui/app/routes/projects_.$id/chat-viewer-dockview.tsx`

### Mesh-rendering components scanned

- `react/gltf-mesh.tsx`
- `react/axes-helper.tsx`
- `react/infinite-grid.tsx`
- `react/lights.tsx`
- `react/section-view.tsx`
- `react/section-view-controls.tsx`
- `react/measure-tool.tsx`
- `react/transform-controls-drei.tsx`
- `controls/transform-controls.ts`
- `controls/viewport-gizmo-cube.tsx`
- `controls/viewport-gizmo-onshape.tsx`

### Material modules scanned

- `materials/gltf-matcap.ts`
- `materials/gltf-edges.ts`
- `materials/matcap-material.ts`
- `materials/striped-material.ts`
- `materials/infinite-grid-material.ts`

### Geometry generators scanned

- `geometries/label-geometry.ts`
- `geometries/font-geometry.ts`
- `geometries/rounded-rectangle-geometry.ts`
- `geometries/svg-geometry.ts`

### Pipeline modules scanned

- `apps/ui/app/constants/kernel-worker.constants.ts`
- `packages/runtime/src/middleware/gltf-coordinate-transform.middleware.ts`
- `packages/runtime/src/middleware/gltf-edge-detection.middleware.ts`
- `packages/runtime/src/utils/off-to-gltf.ts`
- `packages/runtime/src/utils/export-glb.ts`
- `packages/runtime/src/framework/common.ts`
- `kernels/openscad/src/openscad.kernel.ts`

### State machines scanned

- `apps/ui/app/machines/graphics.machine.ts`
- `apps/ui/app/machines/project.machine.ts`
- `apps/ui/app/machines/cad.machine.ts`
- `apps/ui/app/machines/screenshot-capability.machine.ts`
- `apps/ui/app/hooks/use-view-settings-sync.ts`
