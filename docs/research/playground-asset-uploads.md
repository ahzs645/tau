---
title: 'Viewer-supplied asset uploads in the playground'
description: 'The upload mechanism the gallery carries, the kernel gap that once stopped an uploaded SVG from reaching a render, and how the stamp was switched on.'
status: draft
created: '2026-07-25'
updated: '2026-08-10'
category: investigation
related:
  - docs/research/cad-text-and-custom-fonts.md
  - docs/policy/fork-overlay-policy.md
---

# Viewer-supplied asset uploads in the playground

The stamp project is built around artwork the viewer brings — its description literally says
"SVG-driven stamp generator using uploaded artwork" — but for a long time there was no way to supply
that artwork. This records the mechanism, the blocker that kept it switched off, and the shape it
took once it was switched on.

## What is implemented

A project declares what it accepts in `project.json`, so the UI stays generic:

```json
"uploads": [
  { "fileName": "yaa.svg", "accept": ".svg,image/svg+xml", "label": "Artwork (SVG)" }
]
```

- `projects.ts` validates the declaration and surfaces it on `PlaygroundExample.uploads`.
- The playground session keeps `uploadedFiles` — the picked name and its text — merged into the
  preview filesystem alongside the project's own sources.
- Picking a file writes it into the live preview filesystem as `fileName`; the kernel sees a file
  change and re-renders off it (see "the third blocker" below for why the write has to happen that
  way rather than through a remount).
- `parameter` is optional. A model that _selects_ its asset by name (an OpenSCAD customizer field)
  gets that parameter set to `fileName`; a model that reads a fixed name needs nothing pointed at
  it, because the file it reads is the one just replaced. The stamp is the second kind twice over:
  its OpenSCAD `svg_file` already defaults to `yaa.svg`, and its OpenCASCADE variant imports
  `./yaa.svg?raw`.

The control sits at the head of the parameter list, in the pane that is present at every breakpoint
(beside the viewer on desktop, behind the Params tab on mobile), so it needs no separate mobile
treatment. It is _in_ the list rather than pinned above it, because the artwork is a parameter in
every sense that matters — it shapes the stamp the way a dimension does. What is pinned above the
list instead is the project's component switch, which answers a different question: not how this
model is shaped, but which model you are looking at. (`PreviewParameters` grew a `beforeParameters`
slot for this — the smallest extension point that lets the gallery lead the list with something the
schema does not describe.)

It is shaped as **one more parameter row** rather than as a drop card: label, field, description, at
the same height and with the same tokens (`--param-field-h`, `--param-field-radius`) as the rows
under it. A card with its own border and padding is the thing that reads as bolted on; a row reads
as part of the model's inputs, which is what it is. Drag-and-drop comes from `useDropzone` composed
onto the field, the way the import route's `UploadCard` composes it onto its own surface.

Three consequences of taking the row idiom seriously, each of which is also the better behaviour:

- **The slot is not empty on arrival.** A project that declares an upload usually _ships_ the file —
  the stamp renders `yaa.svg` from the moment it loads — so the field names the project's own file
  until the viewer replaces it. An empty state would claim there is no artwork.
- **Replacing it is undoable, and the undo is where a file control puts it.** A replaced file gets a
  clear button at the end of its field, which writes the project's own file back. The first attempt
  used the app's `ModifiedIndicator` — the yellow dot beside the label that marks an overridden
  parameter — for consistency, and it failed the only test that matters: asked where the clear
  option was, someone who had just used the control could not find it. The dot is the right
  vocabulary for a parameter and the wrong one for a file: it is unlabelled, it sits away from the
  field, and a person looking to remove a file looks at the file. Consistency lost to
  discoverability, which is the correct way for that argument to end.
- **The preview is a popover, not a tooltip.** An SVG is a picture and seeing it matters — the
  OpenSCAD variant's render of a stroke drawing looks nothing like the drawing, so the preview is
  the only place the viewer sees what they actually supplied — but a full-size image inside a 24px
  row is not a row. A chip-sized thumbnail sits beside the field and opens the artwork large on
  click. It was a hover tooltip first, which was wrong: this pane is behind the Params tab on a
  phone, and touch has no hover, so the preview would have existed only on desktop. Both images are
  `data:` URLs off the file's own text, so there is no object-URL lifetime to manage.

Checked on a phone viewport rather than assumed: the row keeps its shape at 390 px, picking a file
and resetting both work on tap, and `ModifiedIndicator` already handles the small screen by showing
the reset icon outright instead of the hover-to-reveal dot.

The picked file's name is held in the session rather than in the row, so it survives any remount of
the preview provider — a variant switch, a re-run of the code — and so the session can seed the file
again when one happens.

Uploads are read as text (`file.text()`), so the mechanism covers textual assets — SVG, DXF, JSON, a
kernel source — and not binary meshes.

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

That is still true of the OpenSCAD variant today, and it is why the upload is worth having on the
OpenCASCADE one: `uploads` is declared on the project, and the variant that reads strokes directly
is where uploaded stroke artwork renders as artwork. (Filled SVGs work in both.)

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

## Looking at the render found three more faults

The speedup made the model cheap enough to actually look at, and the first picture of it exposed
three faults the port had carried unseen. All three are the same kind of bug: a detail that only
becomes checkable once geometry exists.

- **No round joins.** `yaa.svg` declares `stroke-linejoin: round` and `stroke-linecap: round`; the
  port extruded bare quads per segment. Every turn left an uncovered wedge on the outer side of the
  corner, which survived the cut as a hair of material running the length of the drawing. A disc of
  the stroke's radius at each distinct stroke end — deduplicated, so a shared joint costs one — is
  precisely what the document asks for, and it removes the hairs entirely.
- **No mirror.** The original sets `reverse_svg = true`, whose `rotate(180)` over `mirror([0,1,0])`
  composes to a negated x. The port never applied it, so it laid the artwork the way a stamp would
  not print it.
- **A scale that does not fit.** `svg_scale = 0.16` puts the drawing at 33.1 x 20.2 mm on a 30 x
  40 mm plate: three millimetres hang off each side. It is not a value anyone could have caught,
  because the artwork imported as nothing. 0.125 gives 25.8 x 15.8 mm and a 2 mm margin.

With joins added, the simplification tolerance also had to come down — at 30° the speech bubble's
lettering melts into the bubble outline:

| Simplification | Render | Reads correctly          |
| -------------- | ------ | ------------------------ |
| 30°            | 45 s   | no — lettering is a blob |
| 14°            | 81 s   | yes                      |
| 8°             | 124 s  | yes, no better than 14°  |

14° is the shipped default. The rendered plate is 30.0 x 40.0 x 2.5 mm and matches the source
drawing — a wolf's head with an `!AAAAAY` speech bubble — checked against a rasterisation of
`yaa.svg` itself.

## Ranked options, with what is known about each

Option 1 was taken and is what found the batch-size cost; the section above records it. The rest
remain open.

1. ~~**Profile the 356 s OCCT render**~~ — done. The cost was mutually intersecting tools per
   boolean call, not the accumulating base, and three of the four earlier optimisations had targeted
   an assumed cost.
2. **One multi-cut against a pristine plate.** Direct test of the accumulating-base hypothesis:
   build all stroke solids lazily, then cut once with all of them as tools so the base is processed
   a single time. Now expected to be _worse_, not better, since it maximises the tool count in one
   call — but it has not been retried at 400.
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

## Switching the stamp on

With the kernel mounting assets and the OpenCASCADE variant rendering the artwork correctly, the
stamp declares `uploads` and the drop zone appears. What the declaration binds to is the point worth
recording: **both variants read the artwork as `yaa.svg`**, so replacing that file _is_ the binding,
and the earlier design's `parameter` — which pointed an OpenSCAD customizer field at a new name —
had nothing to do. Worse, it would have been actively wrong for the OpenCASCADE variant: a TS model
resolves `./yaa.svg?raw` at bundle time, so an upload written as `artwork.svg` would have reached
OpenSCAD and silently missed OCCT. `parameter` is therefore optional, and the stamp declares none.

Verified headlessly, rendering each variant against its own artwork and against a substituted one
(four `<line>` elements forming a square outline) written to the same name:

| Variant     | Shipped `yaa.svg` | Substituted artwork | Reads the replacement |
| ----------- | ----------------- | ------------------- | --------------------- |
| OpenSCAD    | 3596 triangles    | 604 triangles       | yes                   |
| OpenCASCADE | 4064 tri, 44.7 s  | 1268 tri, 2.6 s     | yes                   |

Plate dimensions are unchanged at 30.0 x 40.0 mm in every case; only the artwork cut into the face
moves, which is exactly the expected signature.

The OpenSCAD variant's numbers still describe the wrong picture — it is cutting slivers, not a logo,
for the stroke-versus-fill reason above, and an uploaded stroke drawing gets the same treatment. So
the upload is honest about what it feeds: the OpenCASCADE variant is where uploaded stroke artwork
renders as artwork. Filled SVGs work in both.

## The second blocker: mounted is not the same as tracked

The headless numbers above are real, and the browser still showed nothing. Uploading a completely
different SVG in the running playground produced a pixel-identical render — the drop zone reported
the new file, the preview re-ran, and the plate came back unchanged.

The cause is the first blocker's twin, one layer up. `KernelWorker.computeBaseDependencies` builds
the dependency hash from what the kernel's `getDependencies` reports, and the OpenSCAD kernel
reported only the `include`/`use` graph — the same graph that could never see `import("artwork.svg")`.
Mounting the assets fixed what a _fresh_ render reads; it did not make an asset change produce a
fresh render. With the artwork outside the hash, the geometry cache answered every upload with the
render it already had. A headless probe never sees this, because each process starts with an empty
cache — which is exactly why the earlier measurements looked conclusive.

The fix is symmetry: `getDependencies` now appends the same project asset listing that
`mountProjectAssets` writes, so the files the kernel mounts are the files the render is keyed and
watched on. It is the same argument as the mount, and the same upstream PR: any Tau consumer who
edits an `import()`ed SVG and sees no re-render has this bug, upload or no upload.

The lesson generalises past this kernel: a kernel that reads a file the runtime does not know about
has _two_ obligations, and satisfying only the first fails silently rather than loudly.

## The third blocker: a file replaced between mounts never "changed"

Tracking the asset was necessary and still not sufficient. Instrumenting the kernel's asset listing
in the running app showed the write landing exactly as intended — `yaa.svg` reported at 448 bytes
after uploading the test square and 106,929 bytes after uploading the original back — while every
render after the first answered `Cache hit` on the _same_ dependency hash.

The kernel had the right file list and the wrong file hashes. `computeBaseDependencies` only reads
paths missing from `fileHashCache`, and that cache is invalidated by filesystem _change_ events. The
upload originally worked by bumping a preview version, which remounts the preview provider, which
writes the whole file snapshot on the way up. But the kernel worker outlives that remount: the file
was replaced while nothing was watching, so from the worker's side it never changed, and it kept
hashing the artwork it had read minutes earlier.

So the drop zone writes into the _mounted_ filesystem instead, through the same
`FileContentService` an editor save goes through, and no longer forces a remount. The write is a
change, the change invalidates, and the render that follows reads the artwork the viewer brought.
Measured in the running app (OpenSCAD variant, facet counts from the kernel's own render log):

| Step                    | Kernel sees        | Result                                        |
| ----------------------- | ------------------ | --------------------------------------------- |
| Shipped `yaa.svg`       | `yaa.svg` 106929 B | 4496 facets                                   |
| Uploaded square outline | `yaa.svg` 448 B    | re-renders, 908 facets — a square in the face |
| Uploaded `yaa.svg` back | `yaa.svg` 106929 B | cache hit on the first render, face restored  |

The third row is the one that shows the caching working _for_ us rather than against us: putting the
original artwork back is a dependency hash the kernel has already rendered, so it answers instantly
from cache — correctly, because the inputs really are identical.

The OpenCASCADE variant takes the same round trip and is the one worth looking at, since it renders
stroke artwork as artwork: the square uploads as a clean square ring cut into the plate, and
uploading `yaa.svg` back brings the wolf's head and speech bubble with it. Its artwork arrives
through the bundler rather than the kernel filesystem (`./yaa.svg?raw`), and `bundleResultCache` is
invalidated by the same change event, so nothing extra was needed for it.

The general shape is worth keeping: **staging files through a remount is not a substitute for
telling the runtime they changed.** `KernelWorker.handleStageAndOpenFile` makes exactly this point
in a comment — it invalidates the paths it stages "so the cache contract is identical regardless of
who wrote the bytes" — and a consumer that writes bytes by another route has to honour the same
contract. The public `RuntimeClient` has no `notifyFileChanged`, so the only way to honour it from
the app is to write where the watcher is looking.

## Related: the Replicad stamp

A Replicad variant of the stamp needs the same asset path plus one more piece: Replicad has no SVG
import, so the artwork's paths would have to be parsed into a `Drawing` (a path parser with bezier
support). Its two STL templates are also meshes, not BRep, so `importSTL` output may not fuse
cleanly with solids. Both are worth attempting only after uploads actually reach a render.
