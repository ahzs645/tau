# OpenSCAD ⇄ OpenCASCADE project variants

Status: implemented for four projects (catan-insert, pendant-lamp, vane-trap, pre-chamber-nozzle-insert), 2026-07-04.

## Goal

Let a playground project ship the _same model_ in more than one kernel — an
OpenSCAD original alongside a hand-ported OpenCASCADE (`opencascade.js`)
version — switchable in the playground view, with the originally-authored
version as the default. The OpenCASCADE variant is not just a curiosity: it
produces true BRep solids, which unlocks STEP export that the mesh-only
OpenSCAD kernel cannot offer.

## Why hand-ported, not converted

There is no robust automatic OpenSCAD → OpenCASCADE source converter. The two
languages sit on different paradigms (declarative CSG tree vs. imperative BRep
API). Prior art worth knowing:

| Project                                                                  | What it shows                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [zalo/CascadeStudio](https://github.com/zalo/CascadeStudio) (MIT)        | A concise "standard library" over opencascade.js (`Box`, `Sphere`, `Cylinder`, `Text3D`, `FilletEdges`, Sketch API) and — per its README — an OpenSCAD mode that transpiles OpenSCAD source to that stdlib. Closest existing "BOSL2 for OCCT-in-the-browser".                                                                           |
| [gega/csg2stp](https://github.com/gega/csg2stp)                          | Replays OpenSCAD's `.csg` export (its flattened CSG tree) against OpenCASCADE to rebuild a real BRep/STEP. Validates that the core CSG subset (primitives, booleans, transforms, extrusions) is mechanically convertible. Mesh-emitting constructs (`hull`, `minkowski`, BOSL2 threads, `polyhedron`) are where automation breaks down. |
| [gumyr/cq_warehouse](https://github.com/gumyr/cq_warehouse) (Apache-2.0) | Parametric ISO thread generation (helix + profile sweep with proper end finishes) in Python against the same OCCT API — the reference to port if/when a thread helper is needed.                                                                                                                                                        |
| [ulikoehler/OCCUtils](https://github.com/ulikoehler/OCCUtils)            | C++ convenience layer over OCCT; good catalogue of which helpers matter.                                                                                                                                                                                                                                                                |
| [sgenoud/replicad](https://github.com/sgenoud/replicad)                  | Already in-tree as its own kernel; it _is_ the ergonomic layer over opencascade.js. No thread helper exists there either.                                                                                                                                                                                                               |

## Do we need a BOSL2 equivalent?

No. An audit of the playground gallery's actual BOSL2 usage:

| Project                   | BOSL2 calls                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| 3d-rack-scad              | `cuboid()` (rounded box), `xcyl()`, `up()`                       |
| pendant-lamp              | none — includes `BOSL2/std.scad` but only calls vanilla OpenSCAD |
| pre-chamber-nozzle-insert | `threaded_rod()`                                                 |
| vane-trap                 | `thread_helix()`                                                 |
| all others                | no BOSL2                                                         |

Most of what BOSL2 compensates for in OpenSCAD (rounding, fillets, chamfers)
is _native_ in OCCT (`BRepFilletAPI_MakeFillet` / `MakeChamfer`, exact BRep
instead of tessellated approximations); distributors are plain `for` loops in
TypeScript. The only genuinely missing piece is threads (see cq_warehouse
above). The per-project `lib/occt-utils.ts` shipped with the pilot ports
covers everything else the gallery actually uses.

## How variants work

- `project.json` gains an optional `variants` array
  (`apps/ui/app/routes/playground/projects.ts`):

  ```json
  {
    "entry": "main.scad",
    "variants": [
      { "id": "openscad", "entry": "main.scad" },
      { "id": "opencascade", "entry": "main.occt.ts" }
    ]
  }
  ```

  The variant whose `entry` matches the project `entry` is the default — the
  originally-authored version. Per-variant `exportFormats` default by kernel
  (mesh formats for OpenSCAD, mesh + STEP for BRep kernels).

- The loader validates each variant's entry exists and emits
  `PlaygroundVariant[]` on `PlaygroundExample`.

- The playground route renders a segmented toggle (only for multi-variant
  projects). Switching swaps the effective entry file; **kernel selection
  needs no plumbing** — the runtime picks the kernel from the file extension
  plus `detectImport` (a `.ts` entry importing `'opencascade.js'` routes to
  the opencascade kernel). The variant is folded into the preview project id
  so each variant gets its own IndexedDB filesystem namespace and a clean
  kernel re-init, and it round-trips through a `?variant=` URL param.

- Parameters/presets do **not** carry across a switch: the two variants expose
  different parameter schemas (OpenSCAD globals vs. the TS `defaultParams`
  export), so a switch starts from the new variant's defaults and drops any
  `?p=` share token.

## Porting notes from the pilots

- OpenSCAD `cylinder(d, h, $fn=6)` is a _circumscribed_ hexagonal prism —
  port as a polygonal prism with circumradius `d/2`, not a cylinder.
- `hull()` of two spheres is a capsule: cylinder + two sphere caps. OCCT has
  no general convex hull of solids; model the intent instead.
- `rotate_extrude()` of a translated circle is exactly `BRepPrimAPI_MakeTorus`;
  of a translated rectangle, a washer/tube (cylinder booleans).
- The `projection(cut=true) → offset(-wall) → linear_extrude` hollowing idiom
  has a faithful BRep analogue: section the solid with a plane
  (`BRepAlgoAPI_Section` on a plane face), rebuild the section wires, offset
  them with `BRepOffsetAPI_MakeOffset`, make a face, and `MakePrism` — but it
  is fragile on multi-loop sections. The catan-insert port constructs the
  walls/floors explicitly instead, which is also closer to design intent.
- Emscripten OCCT objects need explicit `.delete()`; the helpers in
  `lib/occt-utils.ts` free intermediates so ported code mostly reads like the
  OpenSCAD original (`translate(box(...))`, `cut(a, b)`, `fuse(...)`).
- **Do not pass a `TopoDS_Compound` as a boolean operand** in this
  opencascade.js build — `Cut` with a compound tool and `Fuse` with a
  compound argument both silently return wrong shapes (observed: the cut
  returning tool material, a fuse dropping all but one component). The
  supported multi-shape path is the BOPAlgo list API: empty constructor +
  `SetArguments(NCollection_List_TopoDS_Shape)` + `SetTools(...)` + `Build()`,
  which is what `lib/occt-utils.ts` uses.

## Thread helpers

`lib/threads.ts` (shipped with the vane-trap and pre-chamber ports) is the
cq_warehouse-inspired thread implementation:

- `helicalRidge()` — BOSL2's `thread_helix()`: a trapezoidal profile swept
  along a sampled-BSpline helix spine with `BRepOffsetAPI_MakePipeShell` in
  Frenet mode, root sunk slightly below the base surface for watertight
  booleans, ends trimmed flush (`blunt_start=false` semantics).
- `threadedRod()` — BOSL2's `threaded_rod()`: ISO 68-1 60° profile
  (depth = 0.5413·pitch, crest flat = pitch/8) fused onto a core cylinder.
  The same solid doubles as the internal-thread cutter
  (`threaded_rod(internal=true)`), verified by cutting a nut probe that
  shows clean female thread grooves.

Cost: an M14×1.25 × 21.5 mm thread (17 turns) sweeps and booleans in a few
seconds inside the kernel — comparable to BOSL2's own helical threads.

## Verification

All variants render headlessly through the real kernels
(`packages/testing/scripts/render-variants.ts`) and compared:

| Project                   | OpenSCAD bbox (mm)    | OpenCASCADE bbox (mm) | Render time   |
| ------------------------- | --------------------- | --------------------- | ------------- |
| catan-insert              | 230 × 285 × 75        | 230 × 285 × 75        | 1.7 s / 4.3 s |
| pendant-lamp              | 200.4 × 200.4 × 183.3 | 200.4 × 200.4 × 183.3 | 44 s / 13 s   |
| vane-trap                 | 130 × 130 × 184       | 130 × 130 × 184       | 5.7 s / 2.0 s |
| pre-chamber-nozzle-insert | 18.54 × 18.54 × 35    | 18.54 × 18.54 × 35    | 26 s / 29 s   |

Bounding boxes match to 0.1 mm and side-by-side renders are visually
identical. Notably the OpenCASCADE pendant-lamp renders ~3.5× faster than
the OpenSCAD original (65 exact tori beat $fn=100 mesh CSG), while the
boolean-heavy catan-insert is faster in OpenSCAD's mesh engine.

### Found while porting: vane-trap's threads cut nothing

vane-trap's `make_jar_threads()` mask is anchored at z ≈ 0 going _up_ into
the already-hollow cone cavity, while the solid jar collar sits at
z ∈ [−8, 0] — and its key-slot cuts sit at the top-rim radius where the
tapered wall no longer reaches. Both subtractions are no-ops in the
original OpenSCAD render, and the port reproduces them verbatim for
parity. Fixing the model (translating the mask down into a bored collar)
would change the OpenSCAD original, left for a separate pass.

## Open follow-ups

- Port more OpenSCAD projects; promote `lib/occt-utils.ts` into
  `libs/tau-examples` (or a kernel builtin module) once ≥3 projects share it.
- Evaluate CascadeStudio's OpenSCAD transpiler for an automated first-pass
  conversion of simple projects.
- `tray-scad`, `wham`, and `saboteur-card-holder` reference include files
  (`Untitled-1.scad`, `grid.scad`) that are missing from their project
  folders — they cannot render in any kernel and need their sources restored.
