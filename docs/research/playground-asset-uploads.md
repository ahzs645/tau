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

Next steps, cheapest first: simplify the polyline (consecutive plotter segments are near-collinear,
so a 0.05 mm tolerance should cut the segment count several-fold at this scale); raise the render
timeout to confirm or rule out the teardown; chain segments into polylines and build one swept solid
per polyline rather than one per segment.

The variant is not registered in `project.json` while it does not render.

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
