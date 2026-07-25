---
title: 'Text and custom fonts across the CAD kernels'
description: 'What each kernel can do with text today, why the gallery uses a stroke font, and how custom fonts should be supplied so the answer survives more than one project.'
status: active
created: '2026-07-25'
updated: '2026-07-25'
category: architecture
related:
  - docs/research/replicad-vs-raw-occt-ports.md
  - docs/research/runtime-asset-and-plugin-library-architecture.md
  - docs/policy/fork-overlay-policy.md
---

# Text and custom fonts across the CAD kernels

Two questions, one answer: why the gallery engraves text with a hand-written stroke font, and what a
sustainable custom-font path looks like for a playground project.

## Executive Summary

The three kernels have three different text stories, and only one of them is missing outlines:

| Kernel      | Text today                                                                                                       | Custom font                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| OpenSCAD    | `text()` via fontconfig/FreeType in the wasm build; fonts are provisioned by `copy-assets`                       | Mount a font file into the kernel FS                                       |
| Replicad    | `drawText` / `sketchText`, backed by opentype.js. **The kernel preloads `Geist-Regular.ttf`** as a runtime asset | `loadFont(bytes, family)` — verified working, including from a fetched URL |
| OpenCascade | **No glyph outlines**: the wasm build excludes `Font_BRepFont`                                                   | Not available without rebuilding the wasm                                  |

So the stroke font in `projects/*/lib/stroke-font.ts` is not a workaround for CAD text in general —
it exists because the _OpenCascade_ variant has no font engine, and because a variant must engrave
the same geometry as its sibling to be comparable. Replicad ports keep using it for that second
reason alone.

Measured (`M14`-style probe rendering `TAU` at 10 mm through the replicad kernel):

| Case                                                                                              | Result                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `drawText('TAU')` with the preloaded font                                                         | 77.3 mm³, 17.14 mm wide, 888 triangles                   |
| `getFont()`                                                                                       | returns `Geist`                                          |
| `loadFont(await fetch(url).arrayBuffer(), 'custom')` then `drawText(…, { fontFamily: 'custom' })` | 62.0 mm³, 19.23 mm wide — a genuinely different typeface |

## What not to do

Three tempting shortcuts that do not survive a second project:

1. **Embed font bytes in the model.** A base64 TTF in a `.ts` file bloats the bundle, the editor and
   every share link, and it hides a licensed asset inside source code.
2. **Fetch from a third-party CDN at render time.** It breaks offline, depends on CORS headers the
   kernel worker cannot control, makes renders non-deterministic, and quietly makes a font vendor a
   runtime dependency of the CAD pipeline.
3. **Rebuild the OCCT wasm with `Font_BRepFont` just for labels.** That is a large binary and build
   cost for a feature that JS already does better — glyph outlines are a 2D problem, and opentype.js
   already solves it.

## Recommended shape

### 1. Fonts are runtime assets, not project code

The pattern already exists twice in this repo, and both times it works: the OpenSCAD kernel ships
BOSL2 as a versioned, lazily-fetched, gzipped asset, and the replicad kernel ships
`fonts/Geist-Regular.ttf` next to its bundle and loads it on init. Generalise that rather than
inventing a third mechanism:

- fonts live under a `fonts/` asset namespace provisioned by `copy-assets`, versioned and recorded
  in `license-deps` (bundle only faces with redistribution rights — Geist is OFL);
- the kernel exposes a `fonts` option (`{ family, url }[]`) so a project asks for a family **by
  name**, and no model contains a URL, a fetch, or a byte array;
- the family name is the whole contract: `drawText('…', { fontFamily: 'my-font' })`.

This is exactly the case `docs/research/runtime-asset-and-plugin-library-architecture.md` already
drafts for libraries and parts; fonts are the same kind of thing and should ride the same road.

### 2. User-supplied fonts arrive through the project filesystem

For a font a _user_ brings, the delivery mechanism should be the one the runtime already has: write
the file into the project filesystem and let the model read it from there. A model should say

```ts
const font = await loadFontFromProject('/fonts/my-font.ttf');
```

not fetch a URL. The same mechanism is what an SVG- or STL-driven project needs (the stamp project
imports `yaa.svg` and two STL templates the same way), so building it once serves both.

### 3. Kernel-agnostic text belongs in JS, not in a kernel

Glyph → outline is a 2D problem that opentype.js already solves, and Replicad proves the shape:
parse the font in JS, emit outlines, let the kernel turn outlines into wires. Lifting that one step
up — into the runtime rather than inside the replicad kernel — would give the OpenCascade kernel
real text without touching its wasm build, and would make text _identical_ across kernels instead
of stroke-font-here, FreeType-there. That is the single highest-value change in this area, and it is
a core-package change, so per the fork policy it wants an upstream PR rather than a local patch.

## Consequences for the gallery today

- `parametric-gel-comb` and `3d-rack-scad` keep their stroke font, now defined once per project in
  `lib/stroke-font.ts` and consumed by both the OCCT and Replicad text builders instead of being
  duplicated per variant.
- A Replicad-only project (no OCCT sibling to match) should use `drawText` directly — the default
  font is already loaded and costs nothing.
- Anything needing a specific typeface should wait for, or implement, the asset path above rather
  than reaching for `fetch` inside a model.
