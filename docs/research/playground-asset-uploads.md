---
title: 'Viewer-supplied asset uploads in the playground'
description: 'The upload mechanism the gallery now carries, and the kernel gap that stops an uploaded SVG from reaching a render.'
status: draft
created: '2026-07-25'
updated: '2026-07-25'
category: investigation
related:
  - docs/research/cad-text-and-custom-fonts.md
  - docs/policy/fork-overlay-policy.md
---

# Viewer-supplied asset uploads in the playground

The stamp project is built around artwork the viewer brings — its description literally says
"SVG-driven stamp generator using uploaded artwork" — but there is no way to supply that artwork.
This records the mechanism now in place, the blocker that keeps it switched off, and what unblocks it.

## What is implemented

A project declares what it accepts in `project.json`, so the UI stays generic:

```json
"uploads": [
  { "parameter": "svg_file", "fileName": "artwork.svg", "accept": ".svg,image/svg+xml", "label": "Artwork (SVG)" }
]
```

- `projects.ts` validates the declaration and surfaces it on `PlaygroundExample.uploads`.
- The playground session keeps `uploadedFiles`, merged into the preview filesystem alongside the
  project's own sources.
- Picking a file writes it in as `fileName`, sets `parameter` to that name, and bumps the preview
  version so the render re-runs. The control sits in the parameters pane header next to Presets —
  the one surface present at every breakpoint (beside the viewer on desktop, behind the Params tab
  on mobile), so it needs no separate mobile treatment.

## Update: the kernel gap is fixed

`mountProjectAssets` in `kernels/openscad/src/openscad.kernel.ts` now mounts the project's own
non-`.scad` files (svg, stl, off, dxf, amf, 3mf, obj, png, json) alongside the sources, so
`import(svg_file)` resolves. Measured on the stamp: the shipped `yaa.svg` went from 412 triangles
(no artwork at all) to 3596, and substituting a different SVG changes the geometry — 560 triangles
for a square-ring test artwork. Viewer-supplied artwork is now possible.

**But the stamp still does not render correctly**, for a reason one layer up: `yaa.svg` is a
stroke-only drawing (`fill: none; stroke: #000`), and OpenSCAD's `import()` builds geometry from
_fill_, not stroke. The model compensates with `offset(r = svg_stroke_width/2)`, which on a
zero-area path produces long radial slivers rather than a logo — visible as spikes across the stamp
face. Fixing that is an artwork/model question (convert the strokes to filled outlines, or handle
stroke width in the model), not a kernel one.

Because of that, `uploads` is still not declared on the stamp: the upload path works end to end, but
what it produces is not yet a good stamp.

## The OpenCascade route: verified unlock, unfinished model

**A TypeScript model can read project assets.** Probed through the runtime's esbuild bundler:

| Import form                       | Result                              |
| --------------------------------- | ----------------------------------- |
| `import art from './art.svg'`     | fails — esbuild reads `.svg` as JSX |
| `import art from './art.svg?raw'` | **works**, arrives as a string      |
| artwork inlined in a `.ts` module | works (but breaks the upload story) |

`?raw` is the answer, and it matters beyond this project: an uploaded file lands in the same
filesystem under the same name, so a TS model reads viewer-supplied assets by the same import.

`projects/stamp/lib/svg-strokes.ts` parses the `<line>` elements and the declared stroke width, then
centres and scales them to millimetres. `projects/stamp/main.occt.ts` builds the plate and gives each
stroke width as a solid — which is the _right_ construction for this artwork, since there is no fill
to import.

It does not render yet, and the obstacle is scale rather than API. 1624 segments is a large boolean
budget:

1. A rod at each segment end plus a body per segment is ~4900 solids — the wasm heap dies with
   `memory access out of bounds` before any boolean runs. Fixed by deduplicating rods per distinct
   vertex (the artwork is a chain, so ends coincide) and then dropping them entirely.
2. One multi-cut with ~1600 tools dies the same way. Fixed by cutting in batches of 200.
3. What remains: the export then fails with `Cannot read properties of undefined (reading
'RWMesh_CoordinateSystem_Zup')` — an OC module-state error after a very long boolean run, whose
   leading hypothesis is a render timeout tearing the module down before export.

Both of those were then tried, and neither is the answer:

- **Polyline simplification helps less than expected.** `simplifyStrokes` merges consecutive
  segments whose direction changes by less than a tolerance: 1624 → 1550 at 2°, 1035 at 6°, 700 at
  12°. The artwork is script lettering, so it is genuinely curvy; there is no run of collinear
  segments to collapse.
- **The leaked transform was not the cause.** Each stroke was built at the origin and then
  translated, and `translate` did not delete its input — a leaked OCCT object per stroke. Building
  each prism at its final height instead removes both the leak and ~1000 transforms. No change.

Measured against the boolean count directly, by rendering at successively finer simplification (each
later row runs against an already-dead module, so only the first row is an independent signal):

| Tolerance | Segments | Result                                   |
| --------- | -------- | ---------------------------------------- |
| 60°       | ~400     | `memory access out of bounds` after 32 s |
| 30°       | ~500     | module already dead                      |
| 15°       | ~640     | module already dead                      |
| 6°        | 1035     | module already dead                      |

So ~400 extruded prisms plus batched cuts already exhausts this wasm build's heap. The per-stroke
construction does not scale to this artwork at any useful fidelity, and tuning the knob does not
change that.

**It renders once the solids are built lazily.** The remaining cause was not the boolean count but
the _live_ shape count: every stroke solid was built up front, so ~1000 OCCT solids existed
simultaneously before the first boolean ran. Building each batch's solids immediately before
consuming them holds the live count at the batch size, and the model completes:

| Tolerance | Segments | Result                                                       |
| --------- | -------- | ------------------------------------------------------------ |
| 30°       | ~400     | **OK, 356 s** — 2553.9 mm³, 2200 triangles, 30 × 40 × 2.5 mm |
| 6°        | 1035     | not shown to finish                                          |

356 seconds is far too slow to be a default in the gallery, and the browser run does not complete at
all: the thumbnail generator waits 15 minutes and no canvas ever appears. So the OpenCASCADE variant
is declared with a 900 s render timeout but is _not_ the project's default entry, and the artwork
still needs the construction below before it is practical.

**One solid per polyline chain is slower, not faster.** The obvious next step — chain the segments
(1624 segments become 236 chains at a 50° split tolerance) and extrude each chain's offset outline as
a single prism — was implemented and abandoned: the render had not finished after 35 minutes, against
356 s for the per-segment version. Fewer tools is not the objective function. A chain of 50 segments
becomes a 100-vertex outline, and OCCT's booleans cost far more on a handful of complex profiles than
on many quads. Anyone reaching for this optimisation should know it has been measured.

What might still make it fast: stop making one solid per stroke. Build the artwork as a **2D** problem — union the
stroke outlines into a single face (or a face per connected polyline), extrude once, and cut once.
That turns ~1000 solids and ~5 batched 3D booleans into a handful of operations. It is a bigger
rewrite of `main.occt.ts` than the current construction, which is why it is written down rather than
attempted at the end of a long session.

The variant is not registered in `project.json` while it does not render.

## Converting the artwork to fills: attempted, also slow

The cheapest-looking fix is to stop working around the artwork and fix it: give `yaa.svg` fill area
so OpenSCAD's `import()` has something to extrude, and the existing variant renders with no kernel or
model work at all.

Attempted by generating a filled version — each `<line>` became a filled quad and each vertex an
octagon for the round join/cap, 3277 subpaths under a single `fill-rule: nonzero` path, which unions
correctly. The render then did not finish in 10 minutes, with or without the model's
`offset(r = svg_stroke_width/2)` (zeroing it is correct once the width is baked into the fill, and
made no difference).

The flaw is in the conversion, not the idea. A real _Stroke to Path_ unions the outlines into a few
dozen closed paths; mine emits 3277 overlapping subpaths and leaves the union to OpenSCAD's 2D
engine, which is exactly the work that makes it slow. Doing this properly needs a polygon-union pass
(Clipper, paper.js, or Inkscape's own) before writing the file. The generated artwork was reverted;
the original stroke drawing is unchanged in the repository.

## Profiling found it: batch size, not construction

Timing each batch of the artwork cut (batches of 100) settles it, and refutes the accumulating-base
hypothesis:

| Batch | Tools | Time        |
| ----- | ----- | ----------- |
| 0     | 100   | 4.6 s       |
| 1     | 100   | **185.1 s** |
| 2     | 100   | **238.6 s** |
| 3     | 100   | 57.6 s      |
| 4     | 7     | 0.2 s       |

Not monotonic — batch 3 is four times faster than batch 2 against a _larger_ base. The cost tracks
how many tools within one operation intersect **each other**: BOPAlgo builds an intersection graph
across all tools, chained strokes all touch their neighbours, and the spikes are the dense passages
of the drawing. Batching by document order groups exactly those together.

Dropping the batch size from 100 to 15 turns every batch into 0.2–1.4 s:

| Simplification | Segments | Before         | After      |
| -------------- | -------- | -------------- | ---------- |
| 30°            | ~400     | 356 s          | **24.4 s** |
| 6°             | 1035     | never finished | **60.9 s** |

A 20x speedup from one constant, and the full-fidelity artwork now renders too. Every earlier
attempt — simplification, chaining, lazy building — was tuning the wrong dimension.

## Ranked options, with what is known about each

1. **Profile the 356 s OCCT render** (`ocTracing: 'per-call'`, which the kernel already supports).
   Every optimisation so far targeted an assumed cost and three of four were wrong. The specific
   hypothesis to test: the cost is the _accumulating base_, not the tools — each batch cuts against
   the result of the previous one, so the plate carries every stroke already engraved and each
   successive cut re-processes all of it.
2. **One multi-cut against a pristine plate.** Direct test of that hypothesis: build all ~400 stroke
   solids lazily, then cut once with all of them as tools so the base is processed a single time.
   This failed at 1600 tools before the live-shape-count fix; it has not been retried at 400.
3. **Union the artwork in 2D.** Replicad has `fuse2D` / `fuseBlueprints` / `cutBlueprints`, so the
   union happens on blueprints and only one 3D boolean remains: sketch once, extrude once, cut once.
   This is the construction most likely to make the model interactive, and it belongs in a Replicad
   variant rather than a raw OCCT one.
4. **Convert the artwork to filled outlines with a real union pass** — the section above. Still the
   cheapest fix if the union is done properly, because it needs no kernel or model changes at all.

## What blocked it (before the fix)

**The OpenSCAD kernel never mounts the uploaded file.** `getReferencedScadFiles` walks the source
for `include <…>` / `use <…>` and mounts what it finds; assets pulled in by `import("artwork.svg")`
are not part of that graph, so they are absent from the kernel filesystem at render time.

Verified headlessly: rendering `stamp/Main.scad` with `svg_file` pointed at a deliberately different
SVG (a large square outline) produces geometry identical to the shipped `yaa.svg` — 11666.1 mm³ and
412 triangles either way. The artwork is not being applied in _either_ case, which means the stamp
as published renders without its SVG at all.

A scanner extension is not sufficient. The stamp writes

```scad
import(svg_file, center = true);
```

— the filename is a _variable_, resolved at OpenSCAD evaluation time from a customizer parameter, so
no static scan of the source can know it. Any project whose asset is parameter-driven has the same
shape.

## What would unblock it

Mount the project's asset files unconditionally rather than by reference-graph discovery: every
non-`.scad` file in the project directory (`.svg`, `.stl`, `.dxf`, `.png`) goes into the kernel FS
next to the sources. It is bounded (project files only, which are already in the preview filesystem),
it costs a few small writes per render, and it makes variable-driven `import()` work by construction.
The same change fixes `surface(file = …)` and STL imports, which have the identical problem.

That is a change in `kernels/openscad`, so per the fork policy it wants an upstream PR rather than a
local patch — it is generic, and any Tau consumer with an asset-driven model hits it.

Until then the mechanism stays in the code with **no project declaring `uploads`**, so no upload
control renders. Switching the stamp on is a four-line `project.json` edit once the kernel mounts
assets.

## Related: the Replicad stamp

A Replicad variant of the stamp needs the same asset path plus one more piece: Replicad has no SVG
import, so the artwork's paths would have to be parsed into a `Drawing` (a path parser with bezier
support). Its two STL templates are also meshes, not BRep, so `importSTL` output may not fuse
cleanly with solids. Both are worth attempting only after uploads actually reach a render.
