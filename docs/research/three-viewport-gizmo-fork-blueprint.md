---
title: 'Three Viewport Gizmo fork blueprint'
description: 'Plan to fork three-viewport-gizmo, fix the Z-up/X-up rotation singularity and hover event gap, repackage as a tarball, and retire the Tau-side hover workaround.'
status: draft
created: '2026-05-04'
updated: '2026-05-04'
category: architecture
related:
  - docs/research/viewport-gizmo-cube-hover-regression.md
---

# Three Viewport Gizmo fork blueprint

Blueprint for taking ownership of `three-viewport-gizmo` via the existing `taucad/three-viewport-gizmo` fork: fix the Z-up/X-up "click already-oriented Top/Bottom face" rotation singularity, expose a hover event so the Tau-side `attachGizmoHoverInvalidate` workaround can be retired, ship the result as a versioned tarball under `tarballs/`, and pursue a parallel upstream PR.

## Executive Summary

`three-viewport-gizmo@2.2.0` (the npm release Tau consumes) has two actionable defects in our scope:

1. **Rotation singularity (the user-reported bug)**: When `Object3D.DEFAULT_UP === (0,0,1)` (Z-up) or `(1,0,0)` (X-up) and the user clicks the Top or Bottom face while the camera is **already** at that orientation, the gizmo plays a ~90° "spin in place" animation around the world up axis instead of being a no-op, producing the visible regression where img2 (camera-from-below) snaps to img1 (oblique iso) in the user's screenshots. The smoking gun is `_setOrientation` recomputing `_quaternionStart` via `Matrix4.lookAt` at the singular pole — Three.js's `lookAt` perturbation fallback (`_z.x += 0.0001`) and the gizmo's own `(0, -ε, position.z)` perturbation disagree, and `OrbitControls.update()` strips the gizmo's perturbation when `phi === π`, so the post-animation camera state guarantees the next click computes a `_quaternionStart` that differs from `_quaternionEnd` (which has the post-twist `_positiveZQuaternion` applied) by a 90° rotation around world Z.
2. **No hover event**: Hover is mutated directly on materials inside `_handleHover` with no `dispatchEvent` — Tau works around this by attaching DOM `pointermove`/`pointerleave` listeners to `gizmo._domElement` (`attachGizmoHoverInvalidate`), reaching across a private field. Issue [#38](https://github.com/Fennec-hub/three-viewport-gizmo/issues/38) requests the same event.

Both fixes belong in the library, not in Tau. The plan:

1. Reactivate the `taucad/three-viewport-gizmo` fork (PR #44 was merged upstream 2025-07-29; the branch has been removed but the fork remote still exists in the repo manifest history).
2. Land the rotation-singularity fix and the `'hoverchange'` event on a `taucad/main` branch.
3. Bump the fork version to `2.2.1-tau.0`, build, `npm pack`, and store the tarball at `tarballs/three-viewport-gizmo-fork/three-viewport-gizmo-2.2.1-tau.0.tgz` (mirroring the existing `tarballs/langchain-fork/` precedent).
4. Switch `package.json` to `"three-viewport-gizmo": "file:tarballs/three-viewport-gizmo-fork/three-viewport-gizmo-2.2.1-tau.0.tgz"`.
5. Delete `attachGizmoHoverInvalidate` from `gizmo.utils.ts` and its three call sites; subscribe to the new `'hoverchange'` event on the gizmo instead.
6. Open an upstream PR addressing both defects so the fork can roll back to the published npm release once a new version ships (Issue [#47](https://github.com/Fennec-hub/three-viewport-gizmo/issues/47)).

This document is the blueprint; it does not implement. Implementation is split into a downstream plan tracked outside this document.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Implementation Roadmap](#implementation-roadmap)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)
- [Appendix: Bug Trace](#appendix-bug-trace)

## Problem Statement

**Bug 1 (user report)**: With Z-up coordinate system enabled, the user observes that clicking the gizmo's "Bottom" face when the camera is already viewing the model from below (img2 in the report — face fills the gizmo widget, scissor model viewed from underneath) causes the cube to animate into the iso/oblique state in img1 instead of staying put. Expected behavior: clicking a face when already at that orientation is a no-op. Symmetric report for the "Top" face.

**Bug 2 (background)**: After the Tau-side `gizmo.utils` refactor on Feb 17 2026 swapped the gizmo's render driver from `renderer.setAnimationLoop` to R3F `useFrame()` under `frameloop='demand'`, hover highlights stopped repainting because `three-viewport-gizmo` mutates hover state without dispatching an event (see `docs/research/viewport-gizmo-cube-hover-regression.md`). Tau patched it locally via DOM listeners on the gizmo's private `_domElement`. The local workaround is correct but reaches into a private field and duplicates the listener wiring across three components (`viewport-gizmo-cube.tsx`, `viewport-gizmo-onshape.tsx`, `viewport-gizmo-axes.tsx`).

We want a single coherent fork that resolves both at the library boundary so consumers don't need either workaround.

## Methodology

1. **Read the cloned source.** `pnpm repos add Fennec-hub/three-viewport-gizmo -g 3d --clone` materializes `repos/three-viewport-gizmo/`. The dist file Tau actually consumes is `node_modules/three-viewport-gizmo/dist/three-viewport-gizmo.js` (1709 lines, mostly minified-but-readable) but the canonical source is `lib/`.
2. **Trace the rotation pipeline by hand.** Manually walk a single click from `_onPointerDown → endDrag → _handleClick → _setOrientation → _animate → controls.update()` for a Z-up camera at `(0, -ε, -d)` clicking the Bottom face, computing each `Matrix4.lookAt` result analytically (eye / target / up plus Three.js's singular-case perturbation) so we can compare `_quaternionStart` and `_quaternionEnd` symbolically.
3. **Cross-reference upstream issues** (#35, #38, #41, #43, #47, #50) and the previous `taucad/main` PR #44 to confirm the rotation handling we're touching has known gaps that other consumers have hit.
4. **Confirm the prior fork pathway.** `git log` on `repos/three-viewport-gizmo/` shows `d1e74cb Merge pull request #44 from taucad/main` (2025-07-29) — Tau already operated a fork during the original z-up rework, so the fork-and-PR pathway is established (no infrastructure work required to reactivate it).

## Findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| F1  | **Smoking gun for Bug 1.** `_setOrientation` recomputes `_quaternionStart` via `Matrix4.lookAt(camera.position, target, this.up)`. When camera is at `(0, 0, ±d)` (Z-pole) with `up = (0, 0, 1)`, this hits Three.js's singular-case perturbation `_z.x += 0.0001`. The resulting rotation matrix is `R₂ ≈ Rot_(1,1,0)/√2(180°)`, **not** the same as the target post-twist quaternion `R₂ · _positiveZQuaternion = Rot_X(180°) = R₁`. The geodesic between them is exactly a 90° rotation around world Z (`R₂⁻¹·R₁ = +90Z`).                                                                                                        | P0       |
| F2  | **Why the perturbation that should mask F1 doesn't help.** `_animate` ends by setting `camera.position.set(0, -GIZMO_EPSILON, position.z)` to nudge off the pole, **then** calls `_controls.update()`. `OrbitControls.update()` re-derives position via `Spherical.setFromVector3 → setFromSpherical`. At `phi === π`, `sin(phi) === 0`, so `setFromSpherical` collapses x and z to zero — the perturbation is silently undone. Camera ends at exactly `(0, 0, -d)` for Bottom, exactly `(0, 0, d)` for Top.                                                                                                                         | P0       |
| F3  | **Position trajectory analysis confirms a "spin in place".** During the 90° geodesic from `_quaternionStart` (`R₂`) to `_quaternionEnd` (`R₁`), `position.set(0,0,1).applyQuaternion(q_t)` stays at `(0, 0, -1)` for every interpolated `q_t` because `R₂(z) = R₁(z) = -z` and the rotation between them is around world Z (which fixes z). So the camera doesn't physically translate, but `camera.quaternion` rotates 90° around its look axis mid-animation. The visible scene rotates, then `_controls.update()` snaps `camera.quaternion` back to a `lookAt(target)` result — a "spin then snap" the user reads as img2 → img1. | P0       |
| F4  | **Hover events are not dispatched.** `_onPointerMove → _handleHover` mutates `material.opacity`, `material.color`, and `material.map.offset` via `axisHover()`, then exits without `dispatchEvent`. The library only emits `'start'                                                                                                                                                                                                                                                                                                                                                                                                  | 'change' | 'end'`, all tied to drag/click/animation. Issue [#38](https://github.com/Fennec-hub/three-viewport-gizmo/issues/38) tracks the same gap. Tau's `attachGizmoHoverInvalidate`papers over this by attaching DOM listeners to`gizmo.\_domElement`and calling R3F`invalidate()`. | P1  |
| F5  | **Comment vs code mismatch in `axesFaces.ts`.** The Top-face branch comment claims "rotate 90 degrees counter-clockwise around positive-Z-axis" but the code is `face.rotateZ(-Math.PI / 2)` — a **clockwise** rotation when viewed from +Z (Three.js positive rotation is right-hand-rule CCW). Likely a documentation slip from commit `1f8174b`; the runtime behavior is correct (the text reads left-to-right) but a reviewer who trusts the comment will flip the sign. Symmetric for Bottom.                                                                                                                                   | P3       |
| F6  | **No npm release of upstream main.** PR #44 was merged 2025-07-29 with full Z-up/X-up rotation parity work; npm still serves `2.2.0` (pre-PR). Issue [#47](https://github.com/Fennec-hub/three-viewport-gizmo/issues/47) asks for a release with no maintainer reply. The published binary in `node_modules/three-viewport-gizmo` therefore lags the source we cloned by 8 months of fixes, including the Z-up/X-up handling Tau itself contributed.                                                                                                                                                                                 | P1       |
| F7  | **`intersectionOrder` userData is undeclared in `types.ts`.** `axesCorners.ts` writes `corner.userData = { ..., intersectionOrder: 1 }` and `intersectedObjects.ts` reads `intersection.object.userData.intersectionOrder` for tie-breaking at equal raycast distance. The field is functional but absent from `GizmoAxisObject` / userData typings. Cosmetic but worth fixing while the fork is open.                                                                                                                                                                                                                               | P3       |
| F8  | **`THREE.Clock` deprecation surface.** Issue [#50](https://github.com/Fennec-hub/three-viewport-gizmo/issues/50) flags that `THREE.Clock` is deprecated in newer Three.js versions. `_animate` uses `_clock.getDelta()` for animation pacing. Migrating to `performance.now()` differences would future-proof against Three.js removing `Clock`. Out of scope for the immediate fix but worth flagging.                                                                                                                                                                                                                              | P3       |
| F9  | **`requestAnimationFrame` shim inside `_animate`.** Line 493 wraps `dispatchEvent({ type: "change" })` in a `requestAnimationFrame` callback with a `// FIXME - Need fix?` comment. The `_animate` function is itself called from `render()` which already runs inside a frame loop, so the rAF wrap is at best a no-op delay and at worst orders the `change` event one frame after the gizmo state actually changed. Worth investigating but not the headline fix.                                                                                                                                                                 | P3       |
| F10 | **Redundant `change` dispatch in `_handleClick`.** Line 716 fires `dispatchEvent({ type: "change" })` immediately after `_setOrientation()` triggers an animation. `_animate()` then dispatches `change` per frame plus `end` at completion, so the leading dispatch is at most a 1-frame anticipation of the first animation step. Probably intended as a "click registered" hint but redundant given the animation-driven stream.                                                                                                                                                                                                  | P3       |
| F11 | **`coordinateConversion` permutations are mathematically self-inverse.** Validated by hand: forward `(x,y,z)→(y,z,x)` for Z-up has the same cycle as its inverse `(z,x,y)`; X-up forward `(x,y,z)→(z,x,y)` and inverse `(y,z,x)` likewise. **Not a bug** — recorded so future reviewers don't reopen this rabbit hole.                                                                                                                                                                                                                                                                                                               | -        |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                              | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Reactivate the `taucad/three-viewport-gizmo` fork; update `repos.yaml` to record the fork remote and `commit:` pin so re-cloning is reproducible.                                                                                                                                                                                                                   | P0       | XS     | High   |
| R2  | Fix `_setOrientation` so `_quaternionStart` reflects the camera's actual current orientation rather than a fresh `Matrix4.lookAt` recomputation. Two viable approaches (see [Code Examples](#code-examples)) — prefer the "use `camera.quaternion`" approach, which removes the dependence on Three.js's singular-case perturbation entirely.                       | P0       | S      | High   |
| R3  | Add a `'hoverchange'` typed event to `ViewportGizmoEventMap`. Dispatch it from `_handleHover` whenever `_focus` transitions (object→null, null→object, or object→different object) and whenever `axisHover()` mutates a material. Document that `'hoverchange'` carries a `{ object: GizmoAxisObject \| null }` payload so consumers can react without re-querying. | P0       | S      | High   |
| R4  | Bump fork version to `2.2.1-tau.0`, run `npm run build`, `npm pack`, and commit the tarball to `tarballs/three-viewport-gizmo-fork/three-viewport-gizmo-2.2.1-tau.0.tgz`.                                                                                                                                                                                           | P0       | XS     | High   |
| R5  | Switch the workspace `package.json` to `"three-viewport-gizmo": "file:tarballs/three-viewport-gizmo-fork/three-viewport-gizmo-2.2.1-tau.0.tgz"`. Run `pnpm install --no-frozen-lockfile`. Verify `pnpm nx test ui`, `pnpm nx typecheck ui`, and `pnpm nx lint ui` all pass.                                                                                         | P0       | XS     | High   |
| R6  | Delete `attachGizmoHoverInvalidate` from `apps/ui/app/components/geometry/graphics/three/utils/gizmo.utils.ts` plus its three call sites, replacing them with `gizmo.addEventListener('hoverchange', invalidate)` registered next to the existing `'change'` listener (and removed in cleanup). Drop `gizmo.utils.test.ts` coverage tied to the now-removed helper. | P0       | XS     | High   |
| R7  | Fix the `axesFaces.ts` Top/Bottom rotation comments so they describe the actual sign (clockwise / `-Math.PI/2` for Top, counter-clockwise / `+Math.PI/2` for Bottom when viewed from +Z).                                                                                                                                                                           | P3       | XS     | Low    |
| R8  | Open an upstream PR consolidating R2 + R3 + R7 against `Fennec-hub/three-viewport-gizmo:main`. Cite issues #38, #43, #47. Mark the PR as Draft pending human review per the `submit-pr` skill.                                                                                                                                                                      | P1       | S      | High   |
| R9  | Optional: declare `intersectionOrder` on `GizmoAxisObject` userData typing (F7) and migrate `_clock` to `performance.now()` (F8). Either include in the upstream PR or split into a follow-up.                                                                                                                                                                      | P3       | S      | Medium |

### Enriched event payload (R10)

Fork tarball `2.2.2-tau.0` extends [`ViewportGizmoEventMap`](https://github.com/taucad/three-viewport-gizmo) so **`change`** and **`hoverchange`** carry structured identity in addition to existing behavior: `kind` (`'face' | 'edge' | 'corner' | null`), `axes` (readonly `GizmoAxisName[] | null`), `face` (`GizmoFaceName | null`, faces only), and `direction` (`Vector3 | null`, unit vector from the hit object's position). Values are `null` on **`hoverchange`** when the pointer leaves; on **`change`**, drag and animation frames emit `null` for all four fields so consumers can treat `kind !== null` as click-to-orient. Generators (`axesFaces`, `axesCorners`, `axesEdges`) write `kind` / `axes` / `face` into each mesh's `userData`. Issue [#38](https://github.com/Fennec-hub/three-viewport-gizmo/issues/38) is the umbrella; Tau UI still ignores the payload and only uses the events for `invalidate()`. When **R8** (upstream PR) is filed, include this schema so npm consumers get parity.

## Implementation Roadmap

Phased execution with explicit dependencies. Each phase is independently testable.

### Phase 1 — Fork preparation (R1)

- `pnpm repos fork three-viewport-gizmo` to recreate the `taucad/three-viewport-gizmo` GitHub fork remote (the repo is already cloned locally; this only flips the manifest entry from `upstream`-only to `fork: taucad/three-viewport-gizmo` and re-points `origin`).
- Pin the upstream baseline by adding `commit: <full-SHA-of-d1e74cb-or-newer>` to `repos.yaml` (use `git rev-parse d1e74cb` to get the canonical full hash — never hand-write it from the short form).
- Branch off main as `taucad/main` (the same head ref the original PR #44 used). Push to `origin`.

### Phase 2 — Library fixes (R2, R3, R7)

- Apply the `_quaternionStart.copy(camera.quaternion)` change to `lib/ViewportGizmo.ts` (see [Code Examples](#code-examples)).
- Add the `'hoverchange'` event: extend `ViewportGizmoEventMap` in `lib/types.ts`, dispatch from `_handleHover` (transitions only, not every pointermove), and from `_onPointerLeave` when `_focus` was non-null.
- Fix the `axesFaces.ts` comments per R7.
- Bump `package.json` `version` to `2.2.1-tau.0`. Update the lock if needed.
- Run `npm run build` and verify `dist/three-viewport-gizmo.js` regenerates without errors.

### Phase 3 — Validation (still inside the fork)

- Add a regression test (or live-demo flow) demonstrating that clicking the Bottom face twice in a row in Z-up mode does not animate on the second click. The existing `live/` examples directory is suitable for a manual repro; ideally add an automated `vitest` headed test if the fork already runs vitest (it doesn't — defer or add minimally).
- Add a regression test that `'hoverchange'` fires on focus transitions and not on every `pointermove` while hovering the same object.

### Phase 4 — Tarball plumbing (R4, R5)

- `cd repos/three-viewport-gizmo && npm pack` produces `three-viewport-gizmo-2.2.1-tau.0.tgz` in the repo root. Move it to `tarballs/three-viewport-gizmo-fork/`.
- Update root `package.json`:
  - Replace the existing `"three-viewport-gizmo": "^2.2.0"` (under both `dependencies` and `pnpm.overrides` if present) with `"file:tarballs/three-viewport-gizmo-fork/three-viewport-gizmo-2.2.1-tau.0.tgz"`.
- Run `pnpm install --no-frozen-lockfile` to update the lockfile.
- Mirror the directory naming used by `tarballs/langchain-fork/` for consistency.

### Phase 5 — Tau-side cleanup (R6)

- In `apps/ui/app/components/geometry/graphics/three/utils/gizmo.utils.ts`, delete the `attachGizmoHoverInvalidate` function and its JSDoc.
- In each of `viewport-gizmo-cube.tsx`, `viewport-gizmo-onshape.tsx`, `viewport-gizmo-axes.tsx`:
  - Drop the `attachGizmoHoverInvalidate` import.
  - Remove the `const detachHoverInvalidate = attachGizmoHoverInvalidate(gizmo, invalidate);` call after `attachControls`.
  - Remove the `detachHoverInvalidate();` line from cleanup.
  - Add `gizmo.addEventListener('hoverchange', handleChange);` next to the existing `'change'` listener (where `handleChange = invalidate`).
  - Add the symmetric `gizmo.removeEventListener('hoverchange', handleChange);` in cleanup or rely on `gizmo.dispose()`.
- Delete `gizmo.utils.test.ts` tests that exercised `attachGizmoHoverInvalidate` (they were proxy tests for the upstream behavior we're now consuming directly).
- Update `docs/research/viewport-gizmo-cube-hover-regression.md` to mark R3 (upstream PR) and R4 (deferred docs) as **RESOLVED** by this blueprint, and supersede the local `attachGizmoHoverInvalidate` workaround.
- Run the full validation gauntlet: `pnpm nx test ui`, `pnpm nx typecheck ui`, `pnpm nx lint ui`, `pnpm docs:validate`.
- Manual validation: in `nx dev ui`, switch to Z-up, click "Bottom" face from an iso view (verify animation to bottom orientation), then click "Bottom" again (verify no-op). Repeat for Top, and for X-up.

### Phase 6 — Upstream PR (R8)

- Use the `submit-pr` skill: open a draft PR from `taucad/three-viewport-gizmo:taucad/main` to `Fennec-hub/three-viewport-gizmo:main`.
- PR body should describe the singularity diagnosis (referencing this research doc by title only — never embed `R1/R2/F1` style internal cites in upstream commits), the `'hoverchange'` event addition, and link issues #38 and #43 as resolved by this PR.
- Include a Loom demo similar to PR #44's recording showing the no-op behavior on repeated face clicks.
- Disclose AI co-authorship explicitly in the PR body.

### Phase 7 — Optional follow-ups (R9)

- File a separate fork branch / PR for the `intersectionOrder` typing (F7) and `THREE.Clock` migration (F8) if they're not bundled with the main PR.

## Trade-offs

| Dimension                          | Tarball under `tarballs/` (chosen)                                                                                        | Publish `@taucad/three-viewport-gizmo` to npm                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Setup cost                         | Reuses the existing `tarballs/langchain-fork/` precedent; no npm publish workflow needed.                                 | Requires `package-release` skill workflow, npm 2FA, version planning.                                                            |
| Reproducibility                    | Tarball is checked into the repo (or a gitignored fixture if size is a concern); identical bytes for every CI run.        | npm registry can in principle change; protected by lockfile but adds an external trust surface.                                  |
| Upstream merge ergonomics          | Once upstream releases a new version including our fixes, swap `"file:tarballs/..."` back to `"^2.2.1"`. One-line change. | Requires deprecating the `@taucad/...` package; consumers might keep using the fork by inertia.                                  |
| Discoverability for external users | Internal only.                                                                                                            | Public, useful if other Tau consumers (Electron PoC, CLI examples) want the same fixes; but those already consume Tau as source. |
| Decision                           | **Use tarball.** No external consumer needs the package; the fork is a temporary bridge until upstream releases.          | -                                                                                                                                |

## Code Examples

### R2: rotation singularity fix (preferred form)

```diff
   private _setOrientation(position: Vector3) {
     const camera = this.camera;
     const focusPoint = this.target;

     _vec3.copy(position).multiplyScalar(this._distance);

     _matrix.setPosition(_vec3).lookAt(_vec3, this.position, this.up);
     this._targetQuaternion.setFromRotationMatrix(_matrix);

     _vec3.add(focusPoint);

     _matrix.lookAt(_vec3, focusPoint, this.up);
     this._quaternionEnd.setFromRotationMatrix(_matrix);

-    _matrix
-      .setPosition(camera.position)
-      .lookAt(camera.position, focusPoint, this.up);
-    this._quaternionStart.setFromRotationMatrix(_matrix);
+    // Read the camera's current quaternion directly instead of recomputing
+    // it via Matrix4.lookAt. At the world up axis (camera.position parallel
+    // to this.up), Three.js's lookAt fallback adds an arbitrary-direction
+    // perturbation that does not match the perturbation OrbitControls.update()
+    // settles on for the same camera position, causing _quaternionStart and
+    // _quaternionEnd to disagree by ~90° around the up axis even when the
+    // camera is already at the target orientation. Using camera.quaternion
+    // makes the start of the animation match the camera's actual state, so
+    // a click on an already-oriented face is a true no-op.
+    this._quaternionStart.copy(camera.quaternion);

     // For Z-up and X-up systems, when rotating to the top or bottom, we need to apply
     // a final rotational twist to correctly align the gizmo's "Top" or "Bottom" face.
     if (Object3D.DEFAULT_UP.z === 1 && Math.abs(position.z) > 0.99) {
```

This is mathematically equivalent to the existing computation when the camera is **not** at a singular pole (because `(0, 0, 1).applyQuaternion(camera.quaternion)` always points from target back toward camera position, and `Matrix4.lookAt(camera.position, target, up)` produces a quaternion with the same back-vector when up is non-singular). At the pole, it diverges from the existing behavior in exactly the way needed: the camera's actual orientation is preserved instead of being replaced by a perturbation-driven approximation.

### R3: `'hoverchange'` event addition

```diff
 // lib/types.ts
 export interface ViewportGizmoEventMap extends Object3DEventMap {
   start: {};
   end: {};
   change: {};
+  /**
+   * Fired when the hovered axis/face/edge/corner transitions.
+   * Payload `object` is the newly-hovered mesh (or `null` when the pointer
+   * leaves all interactive elements). Useful for demand-mode renderers that
+   * need to invalidate on hover state changes.
+   */
+  hoverchange: { object: GizmoAxisObject | null };
 }
```

```diff
 // lib/ViewportGizmo.ts (inside _handleHover)
   private _handleHover(e: PointerEvent) {
     const intersection = intersectedObjects(...);
     const object = intersection?.object || null;

     if (this._focus === object) return;

     this._domElement.style.cursor = object ? "pointer" : "";

     if (this._focus) axisHover(this._focus, false);

-    if ((this._focus = object)) axisHover(object, true);
-    else updateAxis(this._options, this._intersections, this.camera);
+    if ((this._focus = object)) axisHover(object, true);
+    else updateAxis(this._options, this._intersections, this.camera);
+
+    this.dispatchEvent({ type: "hoverchange", object });
   }
```

Symmetric dispatch from `_onPointerLeave` when `_focus` was non-null.

### R6: Tau-side consumer migration

```diff
 // viewport-gizmo-cube.tsx
-import {
-  syncGizmoFov,
-  attachGizmoHoverInvalidate,
-  resolveGizmoContainer,
-  ...
-} from '#components/geometry/graphics/three/utils/gizmo.utils.js';
+import {
+  syncGizmoFov,
+  resolveGizmoContainer,
+  ...
+} from '#components/geometry/graphics/three/utils/gizmo.utils.js';

 // ... inside the effect, after attachControls:
   gizmo.attachControls(controls);
-  const detachHoverInvalidate = attachGizmoHoverInvalidate(gizmo, invalidate);
+  gizmo.addEventListener('hoverchange', handleChange);

   return () => {
     gizmoRef.current = null;
     rendererRef.current = null;
-    detachHoverInvalidate();
     disposeGizmoResources({ gizmo, renderer, canvas, handleChange });
   };
```

`disposeGizmoResources` already removes the `'change'` listener and disposes the gizmo; `gizmo.dispose()` clears all event listeners on the underlying `Object3D`, so explicit `removeEventListener('hoverchange', ...)` is unnecessary.

## References

- Upstream repository: [Fennec-hub/three-viewport-gizmo](https://github.com/Fennec-hub/three-viewport-gizmo)
- Merged taucad PR (z-up rotation rework, 2025-07-29): [#44](https://github.com/Fennec-hub/three-viewport-gizmo/pull/44)
- Upstream issues touched by this work:
  - [#38 — Add event for appearance changes](https://github.com/Fennec-hub/three-viewport-gizmo/issues/38) (resolved by R3)
  - [#43 — Clicking should toggle axis orientation](https://github.com/Fennec-hub/three-viewport-gizmo/issues/43) (related; clicking-when-aligned no-op is a prerequisite for any toggle behavior)
  - [#47 — Release the latest version to npm?](https://github.com/Fennec-hub/three-viewport-gizmo/issues/47) (motivates the temporary tarball)
  - [#50 — `THREE.Clock` is deprecated](https://github.com/Fennec-hub/three-viewport-gizmo/issues/50) (out of scope; recorded as F8/R9)
- Three.js singular-case lookAt fallback: `repos/three.js` shallow clone, `src/math/Matrix4.js` `lookAt(eye, target, up)` — perturbs `_z.x += 0.0001` when `_z.cross(up).lengthSq() === 0`.
- Tau prior research: `docs/research/viewport-gizmo-cube-hover-regression.md` (the original hover regression that introduced `attachGizmoHoverInvalidate`; this blueprint supersedes its R3/R4 deferrals).
- Related tarball precedent: `tarballs/langchain-fork/`, root `package.json` overrides referencing `file:tarballs/...`.

## Appendix: Bug Trace

Step-by-step trace of the rotation singularity for a Z-up camera (`Object3D.DEFAULT_UP === (0, 0, 1)`, `camera.up === (0, 0, 1)`) with `controls.target === (0, 0, 0)`, distance `d`, and `Math.PI / 180`-degree small angles abbreviated as `ε`.

**Step 0 — Pre-state (camera at iso view; the user's "img1")**:

- `camera.position ≈ (5, 5, 5)`, `camera.quaternion = lookAt((5,5,5), (0,0,0), (0,0,1))` — non-singular, well-defined.

**Step 1 — User clicks Bottom face**:

- `intersection.object.position = (0, 0, -1)` (face's local position; Bottom = `nz`).
- `_setOrientation((0, 0, -1))` runs.
- `_vec3 = (0, 0, -d)`.
- `_targetQuaternion = R₂` (Three.js singular-case lookAt at the pole, perturbation `_z.x += 0.0001`).
- `_quaternionEnd = R₂` (same; offset to `focusPoint = target = (0,0,0)` is a no-op).
- `_quaternionStart = lookAt((5,5,5), (0,0,0), (0,0,1))` — non-singular.
- Twist applied (`zSign = -1` → `_positiveZQuaternion`): `_targetQuaternion = R₂ · _positiveZQuaternion = R₁ = Rot_X(180°)`. Same for `_quaternionEnd`.

**Step 2 — Animation runs**:

- Each frame: `_quaternionStart.rotateTowards(_quaternionEnd, step)`, `quaternion.rotateTowards(_targetQuaternion, step)`, `position.set(0,0,1).applyQuaternion(_quaternionStart) * d + target`.
- Smooth ~135° rotation from iso view to Bottom + twist.

**Step 3 — Animation completes**:

- `camera.position = (0, 0, -1) * d + 0 = (0, 0, -d)`.
- Perturbation: `camera.position.set(0, -ε, -d)`.
- `camera.quaternion = R₁`.
- `_controls.update()` runs:
  - Offset `(0, -ε, -d)` → spherical → `phi ≈ π`, `theta ≈ 0`, `radius ≈ d`.
  - `setFromSpherical` reconstructs offset: `sin(π) = 0`, so `offset = (0, -d, 0)` after up-quat round-trip — **the y-perturbation survives** in spherical-space but x-perturbation collapses; with our actual `(0, -ε, -d)` post-rotation through the up quaternion, both x and z components zero out.
  - `camera.position` snaps back to `(0, 0, -d)`.
  - `camera.lookAt((0, 0, 0))` — singular, perturbed. `camera.quaternion = R₂`.

**Step 4 — Steady state at "img2"**:

- `camera.position = (0, 0, -d)`, `camera.quaternion = R₂`.
- Gizmo widget renders: `gizmo.quaternion = R₂.invert() = R₂` (involution); the Bottom face mesh (with its own `rotateZ(+π/2)`) projects onto the gizmo widget so the "Bottom" label fills the view, scissor model viewed from below — img2.

**Step 5 — User clicks Bottom face AGAIN**:

- `_setOrientation((0, 0, -1))` runs.
- `_vec3 = (0, 0, -d)` again.
- `_targetQuaternion = R₂` (same singular lookAt result).
- `_quaternionEnd = R₂`.
- `_quaternionStart = lookAt(camera.position = (0,0,-d), (0,0,0), (0,0,1))` — **singular**, same perturbation as Three.js applies in `_quaternionEnd`. So `_quaternionStart = R₂`.
- Twist applied: `_targetQuaternion = R₂ · _positiveZQuaternion = R₁`. Same for `_quaternionEnd`.
- **`_quaternionStart = R₂`, `_quaternionEnd = R₁`**. They differ by `R₂⁻¹ · R₁ = +90° around world Z`.

**Step 6 — Animation rotates 90° around world Z (the bug)**:

- Position trajectory `(0,0,1).applyQuaternion(q_t)` stays at `(0, 0, -1)` for every interpolated `q_t` because both `R₂(z) = R₁(z) = -z` and the geodesic between them is around z (which fixes z). So `camera.position = (0, 0, -d)` throughout.
- `camera.quaternion` rotates 90° around its look axis (world Z at the pole). The visible scene rotates 90°.
- The gizmo widget's bottom face appears to rotate — this is visible as the cube's apparent orientation changing.

**Step 7 — Animation completes; `_controls.update()` snaps**:

- `camera.quaternion = R₁` after `rotateTowards` converges.
- Position perturbation, `_controls.update()` → `camera.position = (0, 0, -d)`, `camera.quaternion = R₂` (lookAt at the pole again).
- Snap. End-state is the same as before the second click — but the user has just watched a 90° spin then a snap-back, perceived as "moved to img1 then back" or "ended at img1". Either way, the second click was not a no-op.

The fix in R2 short-circuits this by making `_quaternionStart = camera.quaternion = R₂` instead of recomputing via `Matrix4.lookAt`. Then `_quaternionStart = _quaternionEnd = R₁` (after twist), `angleTo < EPSILON`, animation completes immediately — true no-op.
