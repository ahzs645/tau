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

## What blocks it

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
