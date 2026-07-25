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
its raw OCCT port. The geometry is equivalent — same extents once the kernels' differing glTF axis
conventions are accounted for — with no manual memory management and a fifth of the helper code.

The decisive point is not line count but _ownership_: the raw port needs 423 lines of
project-owned `lib/occt-utils.ts` + `lib/threads.ts`, and those files have already forked six ways
across the gallery. The Replicad port needs 90 lines, all of it the thread helper; everything else
is a maintained dependency.

Threads — the one capability [openscad-opencascade-project-variants.md](./openscad-opencascade-project-variants.md)
identified as missing from Replicad — are available, and were measured rather than assumed
(finding 2): a Replicad thread matches the raw helpers' ridge, rod and nut volumes to the digit and
mates with zero interference. **But only with the profile built in the axial plane.** The idiomatic
`sketchHelix(...).sweepSketch(...)` spelling places the profile in the plane normal to the spine,
which tilts it by the lead angle; since the lead angle depends on radius, a male and female thread
of the same nominal pitch come out with slightly different flanks and interfere. Use `makeHelix` +
`genericSweep` with an axial-plane profile wire.

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
4. Added `packages/testing/scripts/compare-threads.ts`, because the vane trap cannot answer the
   thread question: its thread mask is a no-op that intersects nothing, so the model renders
   identically whether the sweep produced a helix or garbage. The script builds an M14 × 2 thread
   with each of the three helpers and measures the bare ridge, a threaded rod, a threaded nut, and
   the intersection of a rod with its matching nut — all from the exported mesh, so no kernel grades
   its own homework, and the ridge is checked against an analytic swept-profile volume (Pappus).

## Findings

### 1. The geometry matches

| Variant                 | Time    | Triangles | Bounds (mm)                      |
| ----------------------- | ------- | --------- | -------------------------------- |
| `vane-trap/openscad`    | 6667 ms | 658       | `[-65, -65, -8] → [65, 65, 176]` |
| `vane-trap/opencascade` | 1357 ms | 9108      | `[-65, -65, -8] → [65, 65, 176]` |
| `vane-trap/replicad`    | 1445 ms | 9104      | `[-65, -8, -65] → [65, 176, 65]` |

The Replicad bounds are the OCCT bounds with Y and Z swapped — an export axis convention
difference (finding 5), not a modelling difference. Render time is within 7% of the raw port.

Across the whole gallery, every OCCT port matches its OpenSCAD original to ≤ 0.061 mm.

### 2. The threads are real — with one API caveat

`M14 × 2`, 20 mm of thread, 0.4 mm clearance. Volumes are measured from the exported mesh; the
ridge is checked against an analytic swept-profile volume of 438.2 mm³.

| Implementation                | ridge         | rod    | nut    | fit (rod ∩ nut) | watertight                      |
| ----------------------------- | ------------- | ------ | ------ | --------------- | ------------------------------- |
| `occt-sampled` (vane-trap)    | 432.1 (−1.4%) | 2529.5 | 6822.2 | 0.0             | yes (`fit` degenerate: 16 tris) |
| `occt-analytic` (pre-chamber) | 432.3 (−1.3%) | 2529.4 | 6822.3 | 0.0             | yes                             |
| `replicad`                    | 432.1 (−1.4%) | 2529.5 | 6822.2 | 0.0             | yes                             |

All three produce a genuine, watertight helical thread whose volume lands within 1.5% of the
analytic expectation, whose female cut survives, and whose male and female halves mate with zero
interference.

**The caveat, found by the mating test.** The Replicad helper was first written the idiomatic way:

```ts
sketchHelix(pitch, length, baseRadius).sweepSketch((plane, origin) => profile.sketchOnPlane(plane, origin), {
  frenet: true,
});
```

That renders, is watertight, and looks correct — and its ridge volume is 3.5% high, its nut 2.4%
off, and `intersect(rod, nut)` is **108.7 mm³**: a ~50 µm interference film over the whole flank,
about a quarter of the ridge's own volume. The parts cannot be assembled without force. The cause is
that `sweepSketch` hands back the plane _normal to the spine_, so the profile is tilted by the lead
angle — and the lead angle depends on radius, so male and female threads of the same nominal pitch
get subtly different flanks. Building the profile in the axial plane and sweeping it with
`genericSweep` reproduces the raw helpers exactly (the table above).

This is the kind of defect a render-and-look-at-it check cannot catch, and it is worth stating
plainly: the risk of the ergonomic layer is not that it cannot do the geometry, it is that a
plausible-looking spelling silently produces a subtly wrong solid.

### 3. The cost difference is a library, not lines

|                          | Raw `opencascade.js`                       | Replicad                         |
| ------------------------ | ------------------------------------------ | -------------------------------- |
| Model                    | 103 lines                                  | 123 lines                        |
| Project-owned library    | 423 lines (`occt-utils.ts` + `threads.ts`) | 90 lines (`threads.replicad.ts`) |
| Manual `.delete()` calls | 38                                         | 0                                |
| Imports                  | 20 OCCT classes + 2 local libs             | 6 library functions              |

The threading helper is where the gap is widest — 90 lines against 130–216, and the sweep itself is
one call:

```ts
const ridge = genericSweep(profileWire, makeHelix(pitch, length, baseRadius), { frenet: true });
```

against `BRepOffsetAPI_MakePipeShell` setup, spine construction, profile polygon building, and nine
`.delete()` calls in the raw ports. The rest of `occt-utils.ts` — frusta, centred boxes, transforms,
boolean wrappers — disappears entirely, because those are library primitives in Replicad.

### 4. Three of the four attempted ports match across a parameter sweep; one does not

Agreement on default parameters proves little — a port can be right at one point
in parameter space and wrong everywhere else. `packages/testing/scripts/compare-ports.ts`
asks the kernel for a model's resolved defaults, sweeps one parameter at a time
around them, and renders both ports for every set.

| Project                     | Ports agree | Notes                                              |
| --------------------------- | ----------- | -------------------------------------------------- |
| `vane-trap`                 | yes         | 0.00% volume, 0.000 mm bounds across the sweep     |
| `pendant-lamp`              | yes         | includes the `pleatsInside` / brim branches        |
| `catan-insert`              | yes         | 17 parameters, hex prisms, capsules, stadium walls |
| `pre-chamber-nozzle-insert` | **no**      | not shipped; see below                             |

**Why the pre-chamber insert did not port.** It is the model that leans hardest on OCCT-specific
boolean control, and a second attempt narrowed the cause to two independent Replicad boolean
failures rather than to missing API surface.

The missing API is real enough:

| Raw port                                                            | Purpose                                                                                                                              | Replicad                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `healedFuse` (fuzzy value + `BOPAlgo_GlueShift` + `simplifyResult`) | Heal the coincident nose-cone/thread-core seam                                                                                       | `fuse()` exposes only `optimisation: 'none' \| 'commonFace' \| 'sameFace'` — no fuzzy value, no glue                         |
| `BRepFeat_MakeCylindricalHole.PerformUntilEnd`                      | Drill the oblique ports as a _local feature_, because "a generic cut with an analytic cylinder leaves retained cutter/chamber faces" | No feature-drilling wrapper — and replicad's bundled OCCT build does not bind the class, so `getOC()` cannot reach it either |
| `segmentedCone`                                                     | Split the conical surface into face domains so the ports cut cleanly                                                                 | No equivalent; a plain revolve is all that is available                                                                      |

But the two failures underneath are sharper than "no fuzzy fuse":

**`fuse` silently returns one operand.** Measured on the second attempt, where the nose is drilled
and bored on its own (a plain cone while every fragile boolean runs) and fused to the threaded stack
afterwards:

| Piece                                     | Volume     | z range          |
| ----------------------------------------- | ---------- | ---------------- |
| nose (drilled, bored)                     | 283.3 mm³  | 0.00 – 7.00      |
| rear (core + ridge + collar + hex, bored) | 4311.9 mm³ | 6.50 – 35.00     |
| `fuse(nose, rear)`                        | 4308.7 mm³ | **6.50** – 35.00 |
| `fuse(rear, nose)`                        | 4308.7 mm³ | **6.50** – 35.00 |

Both operands are valid solids that genuinely overlap (the core radius 6.32 mm sits inside the
cone's 6.71 mm radius at z = 6.5), and the result is the rear alone — the nose is gone, in either
operand order, at a hairline overlap and at 0.5 mm.

**Cuts against a threaded solid remove far more than the tool.** Drilling the three ports after the
ridge exists takes the whole ridge with it (−513 mm³ at 0.4 mm tools, and −335 mm³ even with the
tools shrunk to 0.01 mm, where they should remove nothing).

Those two constraints are mutually exclusive as the model is written: the ports must be cut before
the ridge exists, which forces a later fuse across the nose seam, which is the fuse that drops an
operand. Rebuilding the nose, core and collar as a single revolved profile removes the seam — and
then the port cuts, now running against a threaded body again, destroy the nose instead (−75%).

Worth trying next, in rough order of promise: return the nose and rear as two touching solids rather
than fusing them (correct for rendering, printing and STEP assemblies, though not one watertight
solid); `fuse(..., { optimisation: 'sameFace' })` at the seam; or sweeping the thread profile as part
of the revolved body so no ridge fuse is needed at all.

### 5. The kernels disagree on the glTF axis convention

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

### 6. Two runtime constraints on headless rendering

Both were found while building the comparison harness, both reproduce in a few lines:

- A **second OpenCascade kernel client in one process** fails: `Expected null or instance of
TopoDS_Shape, got an instance of TopoDS_Shape`. The first client works; every later one does not.
- **Kernel selection sticks to the first file in a client**: with `[openscad(), opencascade()]`
  registered, exporting `model.scad` and then `model.ts` feeds the TypeScript to OpenSCAD and
  fails with `syntax error`.

Together they mean a parity test suite must use one client per kernel, which is what the harness
now does.

### 7. Two gallery models do not render at all

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

1. **Author new ports in Replicad by default**, and check the result against a sweep rather than a
   render. Three of four attempted ports matched exactly; the fourth (finding 4) needs boolean
   healing and feature drilling that Replicad does not expose, so a model that fights its booleans
   still belongs on the raw API. Note that `getOC()` is only a partial escape hatch: it reaches
   replicad's own OCCT build, which binds a narrower API than the OpenCascade kernel's.
2. **Sweep threads with an axial-plane profile**, not with `sweepSketch`'s normal plane (finding 2),
   and check a new fitted feature with a mating boolean rather than by looking at it. A rendered,
   watertight, plausible-looking thread was off by a quarter of its ridge volume.
3. **Do not build a per-project OCCT helper library for a new port.** If a helper is needed by more
   than one project, it belongs in one shared place — see the delivery options in
   [openscad-opencascade-project-variants.md](./openscad-opencascade-project-variants.md).
4. **Leave the six existing OCCT ports alone** unless they need changes anyway. They match their
   originals; rewriting working geometry buys nothing. When one does need work, back-port
   `pre-chamber-nozzle-insert`'s analytic-helix thread helper rather than its sampled predecessor.
5. **Run the parity harness in CI** once the render times are acceptable (the full gallery is ~4
   minutes, dominated by two OpenSCAD models at 25 s and 55 s).
