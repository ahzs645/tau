---
title: 'Viewport gizmo cube hover regression'
description: 'Root cause investigation into why the viewport gizmo cube no longer paints hover colors on faces, edges, and corners after the gizmo utilities refactor.'
status: active
created: '2026-05-03'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/three-viewer-white-z-face-artifact.md
  - docs/research/three-viewport-gizmo-fork-blueprint.md
---

# Viewport gizmo cube hover regression

Investigation into a regression where `apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-cube.tsx` no longer repaints hover colors on the underlying `<canvas>` when the pointer moves over a face, edge, or corner of the gizmo cube. The gizmo's hover state changes correctly in memory but is never flushed to the visible canvas.

## Executive Summary

The smoking gun is commit `a0ab6ed5a refactor(ui): extract gizmo utilities into shared module` (Feb 17, 2026). That refactor swapped the gizmo's continuous render driver from `renderer.setAnimationLoop(animation)` (a self-driven `requestAnimationFrame` loop) to R3F's `useFrame()`, which under the existing `frameloop='demand'` Canvas only ticks when something calls `invalidate()`.

The `three-viewport-gizmo` v2.2.0 library updates internal hover state (`_focus`, material color, opacity) inside `_handleHover()` — but it never dispatches a `'change'` event for hover. The component subscribes only to `'change'`, so:

1. Pointer moves over the gizmo div.
2. The library mutates the hovered mesh's material color in place.
3. **No `invalidate()` is queued** → R3F's demand loop never re-runs `useFrame` → `gizmo.render()` is never called → the canvas keeps showing the stale frame.

The user sees a "frozen" gizmo: the cube is rendered once on mount (and re-renders during drag because drag dispatches `'change'`), but hover never repaints. The same regression silently affects `viewport-gizmo-onshape.tsx` and `viewport-gizmo-axes.tsx`, which were refactored in the same commit.

Recommended fix path evolved in two steps:

1. **Interim (removed 2026-05-04):** `attachGizmoHoverInvalidate` bridged DOM `pointermove` / `pointerleave` on the library's private `_domElement` into R3F `invalidate()`.
2. **Current:** Tau consumes a fork tarball `three-viewport-gizmo@2.2.2-tau.0` that dispatches a typed **`hoverchange`** event on hover focus transitions (`docs/research/three-viewport-gizmo-fork-blueprint.md`). As of that release, `hoverchange` and click-driven **`change`** also expose additive fields `kind`, `axes`, `face`, and `direction` for future consumers; the three viewport gizmo components still register `gizmo.addEventListener('hoverchange', handleChange)` next to `'change'` and only use them to call `invalidate()`. `disposeGizmoResources` removes both listeners before `dispose()`.

**Implementation (2026-05-04)**: R1/R2 (DOM bridge + UI unit tests) are **superseded** by the fork. R3/R4 are **superseded** by the same blueprint (library `hoverchange` + documented demand-mode integration there); the temporary `attachGizmoHoverInvalidate` helper and `gizmo.utils.test.ts` were deleted from the UI app.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Smoking Gun Commit](#smoking-gun-commit)
- [Mechanism Walkthrough](#mechanism-walkthrough)
- [Affected Files](#affected-files)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [References](#references)

## Problem Statement

User-visible symptom: the viewport gizmo cube in the bottom-right of the 3D viewer renders with the correct face/edge/corner geometry but no longer highlights the hovered element with the accent color. The hover ring/face is visually frozen even though the cursor changes to `pointer` (which is set on the gizmo's own DOM element by the library).

Click-to-orient still works (clicking a face still snaps the camera). Drag-to-orbit still updates the gizmo. Only **hover** is broken.

## Methodology

1. Read the live `viewport-gizmo-cube.tsx` and shared `gizmo.utils.ts` to understand the current invocation surface.
2. Decompiled `node_modules/three-viewport-gizmo/dist/three-viewport-gizmo.js` (v2.2.0) to identify which internal handlers run on which DOM events and which ones dispatch the `'change'` event the component subscribes to.
3. Cross-referenced commit history with `git log --follow` and `git log -L` on the `useFrame` block to find when the rendering driver changed.
4. Verified the `Canvas` `frameloop` setting in `three-context.tsx` to confirm demand mode is in effect.
5. Re-checked the parallel files (`viewport-gizmo-onshape.tsx`, `viewport-gizmo-axes.tsx`) for the same pattern.

## Findings

### Finding 1: `frameloop='demand'` requires explicit invalidation

```106:135:apps/ui/app/components/geometry/graphics/three/three-context.tsx
  return (
    <Canvas
      key={canvasKey}
      gl={{
        // Enable logarithmic depth buffer for better precision at low field of view,
        // eliminating visual artifacts on the object.
        logarithmicDepthBuffer: true,
        antialias: true,
        // Enable stencil buffer for stencil-based cross-section rendering (Section View component)
        stencil: true,
      }}
      dpr={dpr}
      frameloop='demand'
```

In demand mode R3F only schedules a frame (and therefore only invokes `useFrame` callbacks) when:

- a controlled prop changes that R3F knows about, or
- some code calls `invalidate()` from `useThree`/`@react-three/fiber`.

Hovering over a DOM overlay outside R3F's reconciler does **not** trigger an automatic invalidation.

### Finding 2: Hover mutates material state in place but does not dispatch `change`

From the decompiled library (`three-viewport-gizmo.js` v2.2.0):

```js
_onPointerMove(t) {
  !this.enabled || this._dragging || (this._background && It(this._background, !0), this._handleHover(t));
}

_handleHover(t) {
  const n = Ft(t, this._domRect, this._camera, this._intersections),
        i = (n == null ? void 0 : n.object) || null;
  this._focus !== i && (
    this._domElement.style.cursor = i ? "pointer" : "",
    this._focus && Y(this._focus, !1),
    (this._focus = i) ? Y(i, !0) : Pt(this._options, this._intersections, this.camera)
  );
}
```

`Y(object, hovered)` writes into `object.material` directly:

```js
Y = (s, e = !0) => {
  const { material: t, userData: n } = s,
    { opacity: i, color: o, scale: a } = e ? n.hover : n;
  (s.scale.setScalar(a), (t.opacity = i), t.map ? Re(t.map, e) : t.color.set(o));
};
```

`_handleHover` never calls `dispatchEvent`. A `grep` across the bundle for `dispatchEvent` confirms `'change'` is fired only from:

- animation completion (`_animate`),
- drag-move (`_onPointerDown`'s document-level `pointermove` handler),
- click-to-orient (`_handleClick`).

The `ViewportGizmoEventMap` typed surface (`three-viewport-gizmo.d.ts`) exposes only `start`, `change`, `end` — there is no public hover event.

### Finding 3: Component subscribes to `change` only

```152:154:apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-cube.tsx
    // Add event listeners for the gizmo
    gizmo.addEventListener('change', handleChange);
```

Combined with Finding 2, hover never enqueues an `invalidate()`, so:

```190:196:apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-cube.tsx
  useFrame(() => {
    if (rendererRef.current && gizmoRef.current) {
      rendererRef.current.toneMapping = THREE.NoToneMapping;
      rendererRef.current.clear();
      gizmoRef.current.render();
    }
  });
```

…never runs after the initial frame, leaving the canvas displaying the last state at which `'change'` was emitted (initial mount, or end-of-drag).

### Finding 4: `viewport-gizmo-onshape` and `viewport-gizmo-axes` share the regression

Both sibling components were refactored in the same commit and use the same `useFrame` + `'change'`-only pattern. Hover repaints are silently broken there too; the bug is most visible on the cube because the cube has the largest hover surface area and the most prominent color contrast between idle and hover states.

## Smoking Gun Commit

Commit `a0ab6ed5a` (Feb 17, 2026) extracted the gizmo plumbing into `gizmo.utils.ts`. The functional regression is hidden in the rendering driver swap:

```diff
-    function animation() {
-      // Render the Gizmo
-      renderer.toneMapping = THREE.NoToneMapping;
-      gizmo.render();
-    }
-    ...
-    renderer.setAnimationLoop(animation);
+
+  // Demand-based gizmo rendering: only render when the R3F frame loop fires (on invalidation)
+  useFrame(() => {
+    if (rendererRef.current && gizmoRef.current) {
+      rendererRef.current.toneMapping = THREE.NoToneMapping;
+      gizmoRef.current.render();
+    }
+  });
```

`renderer.setAnimationLoop(animation)` ran `animation()` on every browser `requestAnimationFrame` tick irrespective of R3F's frame loop, so hover state changes were always painted on the next vsync. The replacement `useFrame()` ties rendering to R3F's loop, which under `frameloop='demand'` only ticks when invalidated. The library never invalidates on hover, so the new path silently drops every hover repaint.

The earlier commit `2d552882c feat(ui): implement real-time FOV synchronization for viewport gizmos` had already introduced the `'change' → invalidate()` listener for FOV updates. That listener's coverage was sufficient while `setAnimationLoop` was still driving rendering (the listener was redundant for hover), so when the animation loop was removed the missing hover-side invalidation became load-bearing.

## Mechanism Walkthrough

```
[user moves pointer over gizmo div]
        │
        ▼
gizmo._domElement.onpointermove(e)            ← assigned by library on init
        │
        ▼
ViewportGizmo._onPointerMove(e)
        │
        ├─▶ _handleHover(e)
        │     │
        │     ├─▶ raycast against _intersections
        │     ├─▶ if focus changes:
        │     │     • Y(prevFocus, false)     // restore idle color/opacity/scale
        │     │     • Y(newFocus,  true)      // apply hover color/opacity/scale
        │     │     • set cursor = 'pointer'
        │     └─▶ ── (no event dispatch) ──
        │
        ▼
[handler returns; material state mutated, but DOM canvas unchanged]
        ▲
        │
        │ (R3F demand loop sees no invalidation; useFrame never fires;
        │  no clear() + gizmo.render() runs; old pixels remain on screen)
```

Click-to-orient and drag-to-orbit don't trigger this regression because both paths dispatch `'change'`, which is bridged into `invalidate()` via the existing listener. Hover is the only interaction missing that bridge.

## Affected Files

| #   | File                                                                                 | Symptom                                                                                                            |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-cube.tsx`    | Cube faces/edges/corners do not change color on hover. (Reported case.)                                            |
| 2   | `apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-onshape.tsx` | Onshape-style cube + background sphere has the same bug; only the static base sphere is repainted on `'change'`.   |
| 3   | `apps/ui/app/components/geometry/graphics/three/controls/viewport-gizmo-axes.tsx`    | Hover-cursor still updates (CSS, not WebGL), but axis labels/ticks intended to highlight on hover never re-render. |
| 4   | `apps/ui/app/components/geometry/graphics/three/utils/gizmo.utils.ts`                | Best place for the shared fix because all three call sites already share `disposeGizmoResources`.                  |

## Recommendations

| #   | Action                                                                                                                         | Priority | Effort | Impact | Status                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Interim: `attachGizmoHoverInvalidate(gizmo, invalidate)` on private `_domElement` (pointermove/pointerleave → `invalidate()`). | P0       | Low    | High   | **SUPERSEDED** — removed; use library `hoverchange` (fork `2.2.2-tau.0`)                                                                     |
| R2  | Interim: `gizmo.utils.test.ts` for the DOM bridge.                                                                             | P1       | Low    | Medium | **SUPERSEDED** — deleted; fork has Vitest coverage for `hoverchange`                                                                         |
| R3  | Library should dispatch `'hoverchange'` on hover focus transitions.                                                            | P2       | Med    | Medium | **SUPERSEDED** — implemented in `taucad/three-viewport-gizmo`; see `three-viewport-gizmo-fork-blueprint.md` (upstream PR still out of scope) |
| R4  | Document demand-mode contract (any DOM-driven gizmo visual state must reach `invalidate()`).                                   | P2       | Low    | Low    | **SUPERSEDED** — contract captured in fork blueprint; UI listens to `hoverchange` + `change`                                                 |

### Historical interim fix (removed 2026-05-04)

The following DOM-bridge shape was shipped briefly before the fork tarball added `hoverchange`:

```typescript
// gizmo.utils.ts (removed)

/**
 * Bridge `three-viewport-gizmo` hover events into R3F's demand-mode frame loop.
 *
 * The library mutates material state in `_handleHover` but does not dispatch any
 * public event. Without this bridge the canvas does not repaint while the user
 * hovers (the `'change'` event only fires on click/drag/animation).
 */
export function attachGizmoHoverInvalidate(gizmo: ViewportGizmo, invalidate: () => void): () => void {
  const domElement = (gizmo as unknown as { _domElement: HTMLElement | undefined })._domElement;
  if (!(domElement instanceof HTMLElement)) {
    return () => {};
  }
  const handler = (): void => invalidate();
  domElement.addEventListener('pointermove', handler);
  domElement.addEventListener('pointerleave', handler);
  return () => {
    domElement.removeEventListener('pointermove', handler);
    domElement.removeEventListener('pointerleave', handler);
  };
}
```

Call site pattern (removed from `viewport-gizmo-*.tsx`):

```typescript
const detachHoverInvalidate = attachGizmoHoverInvalidate(gizmo, invalidate);

return () => {
  gizmoRef.current = null;
  rendererRef.current = null;
  detachHoverInvalidate();
  disposeGizmoResources({ gizmo, renderer, canvas, handleChange });
};
```

**Replacement:** subscribe to `hoverchange` with the same `handleChange` callback as `change`, and remove both in `disposeGizmoResources`.

## Trade-offs

| Approach                                                  | Pros                                                    | Cons                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Consume fork `hoverchange` + `change` → `invalidate()`    | No `_domElement` reach-in; same demand-mode semantics.  | Depends on Tau tarball until upstream publishes an equivalent release.                                            |
| Render the gizmo synchronously inside the pointer handler | Skips R3F entirely; minimum overhead per pointer event. | Diverges from the existing `useFrame` rendering path; harder to reason about ordering vs. parent scene re-paints. |
| Switch the Canvas back to `frameloop='always'`            | One-line change.                                        | Defeats the demand-mode optimization across the entire viewer; unrelated GPU cost.                                |
| Restore `renderer.setAnimationLoop(animation)`            | Pre-regression behavior.                                | Reintroduces a continuous gizmo render loop independent of R3F; double-rAF overhead in some browsers.             |
| Wait for upstream npm release with `hoverchange`          | Drops tarball when maintainer ships a release.          | Out-of-band; Tau uses `file:tarballs/.../three-viewport-gizmo-2.2.2-tau.0.tgz` until then.                        |

## References

- `three-viewport-gizmo@2.2.2-tau.0` (Tau fork tarball) — `_handleHover`, `hoverchange`, enriched `change` / `hoverchange` payloads, `ViewportGizmoEventMap`.
- Historical: `node_modules/three-viewport-gizmo` v2.2.0 npm — no hover event.
- Commit `a0ab6ed5a` — "refactor(ui): extract gizmo utilities into shared module" (smoking gun).
- Commit `2d552882c` — "feat(ui): implement real-time FOV synchronization for viewport gizmos" (introduced the `'change' → invalidate()` bridge that became insufficient post-refactor).
- Commit `8e87fca4d` — "perf(ui): optimize rendering performance through memory allocations and compute reuse" (added `forceContextLoss` cleanup; unrelated to the hover regression).
- React Three Fiber demand-mode docs — `frameloop='demand'` semantics.
