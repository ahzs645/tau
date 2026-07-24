---
title: 'Replicad vs raw opencascade.js for playground kernel ports'
description: 'Ports the vane trap to Replicad alongside its raw opencascade.js port and measures both against the OpenSCAD original, to decide which layer new ports should target.'
status: active
created: '2026-07-24'
updated: '2026-07-24'
category: comparison
related:
  - docs/research/openscad-opencascade-project-variants.md
  - docs/policy/fork-overlay-policy.md
  - apps/ui/app/routes/playground/projects/AGENTS.md
---

# Replicad vs raw opencascade.js for playground kernel ports

Decides which layer a new playground kernel port should target: the raw `opencascade.js` API with a
project-owned helper library, as the six existing OCCT ports do, or Replicad — the ergonomic layer
over the same kernel that is already an in-tree kernel plugin.

## Executive Summary

**New ports should target Replicad.** The vane trap was ported to Replicad
(`projects/vane-trap/main.replicad.ts`) and rendered head-to-head against its OpenSCAD original and
its raw OCCT port. The geometry is equivalent — same triangle count to within 4 triangles, same
extents once the kernels' differing glTF axis conventions are accounted for — at a third of the code
and with no manual memory management.

The decisive point is not line count but _ownership_: the raw port needs 423 lines of
project-owned `lib/occt-utils.ts` + `lib/threads.ts` to exist at all, and those files have already
forked six ways across the gallery. The Replicad port needs no project-owned library, because the
library is a maintained dependency.

Threads — the one capability [openscad-opencascade-project-variants.md](./openscad-opencascade-project-variants.md)
identified as missing from Replicad — are available: `sketchHelix` + `sweepSketch` produce the same
swept trapezoid the hand-written helper builds, from an exact analytic helix, in one call.

## Problem Statement

The existing porting guidance concluded that no "BOSL2 for OCCT" layer was needed, because a small
per-project `lib/occt-utils.ts` covered what the gallery used. Six ports later that conclusion has
been overtaken by its own evidence:

- `occt-utils.ts` exists in six copies. Three (`catan-insert`, `pendant-lamp`, `vane-trap`) are
  byte-identical; `pre-chamber-nozzle-insert` has diverged to 529 lines with `healedFuse`
  (fuzzy value + `BOPAlgo_GlueShift` + `simplifyResult`), `cutSequentially` and
  `drillCylindricalHole` — the robustness fixes the other five will need next.
- `threads.ts` exists twice and the two are different constructions: `vane-trap` samples a BSpline
  spine through 48 points per turn, `pre-chamber-nozzle-insert` builds an exact analytic helix on a
  `Geom_CylindricalSurface` with run-out trimming. The better one never propagated.
- `text.ts` exists twice with 160 diverged lines.

Improvements do not propagate between copies, so every port starts from whichever snapshot was
copied and re-learns the same failures.

## Methodology

1. Ported `projects/vane-trap` to Replicad with the same construction order as `main.occt.ts`,
   including the two no-op cuts the OCCT port reproduces for structural fidelity.
2. Reworked `packages/testing/scripts/render-variants.ts` to read variants from `project.json` and
   report bounding box, triangle count and render time per variant.
3. Rendered every declared variant of every gallery project through the real kernels and compared
   each port against its OpenSCAD original.

## Findings

### 1. The geometry matches

| Variant                 | Time    | Triangles | Bounds (mm)                      |
| ----------------------- | ------- | --------- | -------------------------------- |
| `vane-trap/openscad`    | 6667 ms | 658       | `[-65, -65, -8] → [65, 65, 176]` |
| `vane-trap/opencascade` | 1357 ms | 9108      | `[-65, -65, -8] → [65, 65, 176]` |
| `vane-trap/replicad`    | 1445 ms | 9104      | `[-65, -8, -65] → [65, 176, 65]` |

The Replicad bounds are the OCCT bounds with Y and Z swapped — an export axis convention
difference (finding 3), not a modelling difference. Render time is within 7% of the raw port.

Across the whole gallery, every OCCT port matches its OpenSCAD original to ≤ 0.061 mm.

### 2. The cost difference is a library, not lines

|                          | Raw `opencascade.js`                       | Replicad            |
| ------------------------ | ------------------------------------------ | ------------------- |
| Model                    | 103 lines                                  | 168 lines           |
| Project-owned library    | 423 lines (`occt-utils.ts` + `threads.ts`) | none                |
| Manual `.delete()` calls | 38                                         | 0                   |
| Imports                  | 20 OCCT classes + 2 local libs             | 4 library functions |

The model file is longer in Replicad because the helpers it uses inline (frustum via revolved
profile, the thread helper) live in the model rather than in a shared file. Move those two helpers
to a shared location and the Replicad model is ~110 lines with no library to maintain.

The threading helper is where the gap is widest:

```ts
// Replicad — exact helix, profile placed on the plane normal to the spine start
const ridge = sketchHelix(pitch, length, baseRadius).sweepSketch(
  (plane, origin) => profile.sketchOnPlane(plane, origin),
  { frenet: true },
);
```

against 130–216 lines of `BRepOffsetAPI_MakePipeShell` setup, spine construction, profile polygon
building, and nine `.delete()` calls in the raw ports.

### 3. The kernels disagree on the glTF axis convention

Reproduced with a 10 × 20 × 40 box authored Z-up in each kernel and exported to GLB:

| Kernel        | `coordinateSystem` | Resulting bounds (mm)                            |
| ------------- | ------------------ | ------------------------------------------------ |
| `opencascade` | `z-up`             | `[0,0,0] → [10,20,40]` (Z-up, as asked)          |
| `replicad`    | `z-up`             | `[-5,0,-10] → [5,40,10]` (Y-up — option ignored) |
| `replicad`    | `y-up`             | `[-5,-10,-40] → [5,10,0]` (rotated twice)        |
| `replicad`    | default            | same as `z-up` → Y-up                            |

`packages/runtime/src/framework/common.ts:transformVertexArray` applies a Z-up→Y-up transform
unconditionally on the replicad and jscad paths, while the OpenCascade path honours the
`coordinateSystem` option (`opencascade-mesh.ts`). So the option is effectively inverted for
Replicad, and `'y-up'` double-rotates. This matters for anything consuming exported files — slicers,
AR Quick Look, glTF viewers — more than for the in-app preview.

### 4. Two runtime constraints on headless rendering

Both were found while building the comparison harness, both reproduce in a few lines:

- A **second OpenCascade kernel client in one process** fails: `Expected null or instance of
TopoDS_Shape, got an instance of TopoDS_Shape`. The first client works; every later one does not.
- **Kernel selection sticks to the first file in a client**: with `[openscad(), opencascade()]`
  registered, exporting `model.scad` and then `model.ts` feeds the TypeScript to OpenSCAD and
  fails with `syntax error`.

Together they mean a parity test suite must use one client per kernel, which is what the harness
now does.

### 5. Two gallery models do not render at all

`projects/periodic-table` and `projects/keyguard-with-raised-tabs` fail with `syntax error` before
any port work. Minimal repro — two customizer parameters carrying option specs, separated by a
group header:

```scad
RoundedBottom = "EW"; // [N:None, EW:East-West, NS:North-South]
/* [Walls] */
NorthWallOpen = 0; // [0:Closed, 1:Open]
cube(1);
```

Removing the option spec from the _second_ parameter makes it render. This is unrelated to the
Replicad question but was surfaced by rendering the whole gallery headlessly for the first time.

## Recommendation

1. **Author new ports in Replicad.** Reserve raw `opencascade.js` for what Replicad cannot express,
   and drop to `getOC()` inside an otherwise-Replicad model when that happens, rather than porting
   the whole model to the raw API.
2. **Do not build a per-project OCCT helper library for a new port.** If a helper is needed by more
   than one project, it belongs in one shared place — see the delivery options in
   [openscad-opencascade-project-variants.md](./openscad-opencascade-project-variants.md).
3. **Leave the six existing OCCT ports alone** unless they need changes anyway. They match their
   originals; rewriting working geometry buys nothing. When one does need work, back-port
   `pre-chamber-nozzle-insert`'s analytic-helix thread helper rather than its sampled predecessor.
4. **Run the parity harness in CI** once the render times are acceptable (the full gallery is ~4
   minutes, dominated by two OpenSCAD models at 25 s and 55 s).
