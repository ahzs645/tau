---
title: 'Gallery Interface Audit — Mobile + Desktop, August 2026'
description: 'Empirical audit of the deployed Pages gallery (3dd.ahmadjalil.com) across phone, tablet, laptop, and desktop viewports: render failures across the model catalogue, responsive breakpoint gaps, crawlability regressions, and the upstream work available to pull in.'
status: draft
created: '2026-08-15'
updated: '2026-08-15'
category: audit
related:
  - docs/policy/fork-overlay-policy.md
  - docs/policy/accessibility-policy.md
  - docs/research/taucad-dev-ui-audit-may-2026.md
  - docs/research/openscad-playground-parity-and-library-first.md
---

# Gallery Interface Audit — Mobile + Desktop, August 2026

Every surface the fork actually deploys, driven in a real browser at four viewports, plus the state of
upstream `taucad/tau` relative to this fork.

## Executive Summary

The desktop model page is the strongest thing this fork ships and needs almost nothing. The problems
are elsewhere, and two of them are severe enough to outrank every layout question:

1. **Five of the fourteen gallery models never render.** `saboteur-card-holder`, `tray-scad`,
   `keyguard-with-raised-tabs`, `periodic-table`, and `pendant-lamp` sit on the splash logo
   indefinitely at every viewport. Nothing is surfaced to the viewer — no error, no retry, and the
   Export control stays disabled forever. That is 36% of the catalogue, and the gallery card gives no
   hint which ones work.
2. **The site tells search engines to go away.** `robots.txt` serves `Disallow: /` and `sitemap.xml`
   is an empty `<urlset>`, because both routes gate on `metaConfig.appDomain` (`tau.new`) and the fork
   deploys to `3dd.ahmadjalil.com`. A public gallery that cannot be indexed is doing a lot of work for
   nobody.

The responsive work that has been done is real and mostly sound — no horizontal overflow anywhere, a
safe-area-aware bottom bar, a viewer toolbar that collapses into its settings menu under pressure. The
gaps that remain are concentrated in the 768–1279 px band (tablets and small laptops get the phone
layout) and in the mobile parameter loop (you cannot see the model while you change it, even though
this codebase already contains the pattern that fixes it).

Upstream `main` has nothing to offer: four commits since the fork diverged, all repo-scaffolding
tooling. The real upstream work lives on the unmerged `geospec` branch — 471 commits, active through
today — and it contains at least one change that directly fixes a defect measured here.

## Table of Contents

- [Methodology](#methodology)
- [Surface Inventory](#surface-inventory)
- [Findings — Broken](#findings--broken)
- [Findings — Responsive and Layout](#findings--responsive-and-layout)
- [Findings — Content and Labelling](#findings--content-and-labelling)
- [What Already Works](#what-already-works)
- [Upstream Status](#upstream-status)
- [Recommendations](#recommendations)

## Methodology

The deployed Pages site is the subject, not a local dev server: `apps/ui` builds differently for
Pages (`GITHUB_PAGES=true`, `TAU_DISABLE_CODE_EDITOR=true`, a hand-written route table in
`routes.ts`), so a local `nx serve ui` would audit an app the public never sees.

Chromium cannot reach the sandbox's egress proxy directly, so the deployed origin was mirrored onto
`127.0.0.1:8099` by a small reverse proxy that fetches each miss with `curl` and caches it. The mirror
also injects `cross-origin-opener-policy` / `cross-origin-embedder-policy`, which GitHub Pages cannot
set, so the `SharedArrayBuffer`-backed kernels behave as they would on a cross-origin-isolated host.
233 resources were fetched over the run with exactly one non-200 (`/docs`, see F4), so no finding
below is an artifact of a missing asset.

| Tool                     | Use                                                                        |
| ------------------------ | -------------------------------------------------------------------------- |
| Playwright 1.56 + bundled Chromium | Drove every surface; screenshots, DOM geometry, console capture   |
| Local mirror (`curl`-backed) | Served the deployed origin with COOP/COEP so kernels could run          |
| `curl`                   | HTTP status, `robots.txt`, `sitemap.xml`, `404.html` verification          |
| `git` against a fresh `taucad/tau` clone | Divergence point, upstream branch survey, overlap analysis |

Viewports, chosen to bracket each breakpoint in the route (`sm` 640, `md` 768, `xl` 1280):

| Name    | Size       | Touch | Stands in for            |
| ------- | ---------- | ----- | ------------------------ |
| mobile  | 390 × 844  | yes   | iPhone 14/15 portrait    |
| tablet  | 820 × 1180 | yes   | iPad Air portrait        |
| laptop  | 1280 × 800 | no    | 13" laptop, `xl` floor   |
| desktop | 1440 × 900 | no    | Standard desktop         |

## Surface Inventory

The Pages route table (`apps/ui/app/routes.ts`, `githubPagesRoutes()`) ships far less than the repo
contains. Everything else — `/projects`, the chat editor, `/files`, `/settings_`, `/convert` — is
upstream's app and is not deployed here, so it is out of scope for this audit.

| Surface              | Route                          | Status                                            |
| -------------------- | ------------------------------ | ------------------------------------------------- |
| Gallery              | `/`                            | Works; layout defects F7–F9, F15                  |
| Model page           | `/:model`                      | Works for 9/14 models; F1–F3, F10–F13, F16        |
| Model page (static)  | `/:model` (`mode: 'static'`)   | Works; no export offered (F20)                    |
| Docs index           | `/docs`                        | **404** (F4)                                      |
| Docs pages           | `/docs/runtime/*`, `/docs/editor/*` | Work; unlinked from every shipped surface    |
| Legal                | `/legal`, `/legal/*`           | Work                                              |
| Crawl metadata       | `/robots.txt`, `/sitemap.xml`  | **Both disable the site** (F5)                    |
| Not-found            | `/404.html`                    | Unstyled bare HTML (F6)                           |

## Findings — Broken

### F1: Five of fourteen models never render

A sweep loaded every catalogue entry at 1440 × 900 and polled up to 45 s for a drawn canvas.

| Model                       | Title                          | Result | Params | Kernel error                       |
| --------------------------- | ------------------------------ | ------ | ------ | ---------------------------------- |
| `3d-rack-scad`              | 3D Rack System                 | OK 15s | 33     | —                                  |
| `atmospheric-sampler`       | Atmospheric Sampler            | OK 3s  | 0      | — (static)                         |
| `saboteur-card-holder`      | Card Holder Grid               | **FAIL** | 0    | none logged                        |
| `catan-insert`              | Catan Box Insert               | OK 4s  | 17     | —                                  |
| `tray-scad`                 | Custom Tray System             | **FAIL** | 0    | none logged                        |
| `keyguard-with-raised-tabs` | Customizable Keyguard          | **FAIL** | 152  | `syntax error in /main.scad:6112`  |
| `periodic-table`            | Interlocking Boxes System      | **FAIL** | 21   | `syntax error in /main.scad:296`   |
| `pet-bottle-opener`         | Modular PET Bottle Opener      | OK 18s | 21     | —                                  |
| `networking`                | Network Equipment Rack         | OK 4s  | 10     | —                                  |
| `parametric-gel-comb`       | Parametric Gel Comb            | OK 4s  | 34     | —                                  |
| `pendant-lamp`              | Pleated Pendant Lamp           | **FAIL** | 9    | none logged                        |
| `pre-chamber-nozzle-insert` | Pre-Chamber Nozzle Insert      | OK 3s  | 0      | — (static)                         |
| `stamp`                     | Stamp                          | OK 5s  | 12     | —                                  |
| `vane-trap`                 | Vane Trap Device               | OK 7s  | 18     | —                                  |

Two distinct failure shapes are in here. `keyguard-with-raised-tabs` and `periodic-table` fail with a
reported syntax error at a line **past the end of the checked-in file** — `periodic-table/main.scad`
is 285 lines and the parser dies at 296 — so the fault is in generated or injected source, not in the
project as committed. The other three parse to zero or few parameters and produce nothing at all,
which points at the source never loading rather than at the kernel.

### F2: A failed render is a permanent splash screen with no message

Whatever the cause, the viewer's failure state is the same: the Tau logo, forever. No error text, no
retry affordance, no indication that anything went wrong; the Export button simply stays disabled and
the orientation gizmo renders as an empty circle. The kernel error reaches the browser console and
stops there.

The chrome for this already exists and is simply never reached. `ModelViewer` renders a proper error
overlay when given one (`aria-label='Preview error'`, showing `error.message`), and the playground
passes it through as `error={displayError}`. The kernel's parse failure never becomes a
`displayError`, so the route falls through to `ModelViewer` with zero geometries and no error — which
is, by definition, the loading state. `RenderStatusOverlay` only ever draws for `'loading'`.

This is the perpetual-loading shape this project has already ruled against elsewhere: every outcome
should reach the render gate as a typed state, not just the success path. The gap here is in the
kernel-error → `displayError` path, not in the viewer.

### F3: Enum parameters whose value is `0` render as empty dropdowns

On `/periodic-table`, three selects render blank and carry the orange "modified" dot even though the
viewer has touched nothing: `North Wall Open`, `South Wall Open`, `Suppress Male DT`. Their sibling
`Suppress Female DT` renders `True` correctly. `/keyguard-with-raised-tabs` shows the same shape on
`Keyguard Display Angle`.

The discriminator is the value, not the declaration. In `periodic-table/main.scad`:

```scad
NorthWallOpen    = 0; // [0:Closed, 1:Open]     -> blank
SouthWallOpen    = 0; // [0:Closed, 1:Open]     -> blank
SuppressMaleDT   = 0; // [1:True, 0:False]      -> blank
SuppressFemaleDT = 1; // [1:True, 0:False]      -> "True"
RoundedBottom = "EW"; // [N:None, EW:East-West] -> "East-West"
```

Every blank one holds `0`. The customizer parser is not at fault — `parseOptionEntry` in
`kernels/openscad/src/parse-parameters.ts` converts `0:Closed` to `{ value: 0, name: 'Closed' }`
correctly, and `createSchemaProperty` emits `oneOf: [{ const: 0, title: 'Closed' }, …]`. Nor is
`SelectWidget`, which stringifies through `String(value ?? '')` and so survives `0`. The fault is
between them: the widget is receiving `undefined`, which also explains the false modified-dot
(`hasCustomValue` sees a value that differs from the default).

That the same models also emit an injected-source syntax error is very likely one bug, not two: a
parameter whose value is lost on the way to the form is a parameter with nothing to inject, and
`NorthWallOpen = ;` is exactly the kind of line that fails to parse past the end of the file.

### F4: `/docs` 404s while its children work

`/docs` → 404, `/docs/runtime` → 200. `listStaticPrerenderPaths()` derives docs URLs by globbing
`content/docs/**/*.mdx`, and there is no root `index.mdx` — `content/docs/` holds only `editor/`,
`runtime/`, and `meta.json` — so no `/docs` page is ever emitted. The route is registered in
`githubPagesRoutes()`, which makes it look supported.

Nothing on any shipped surface links to `/docs` in any case: the gallery has no header and the model
page's only navigation is the Gallery button. The docs are deployed and unreachable except by typing
the URL.

### F5: The gallery is deindexed by its own configuration

```
$ curl https://3dd.ahmadjalil.com/robots.txt
User-agent: *
Disallow: /

$ curl https://3dd.ahmadjalil.com/sitemap.xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
```

Both routes call `isCanonicalProductionUrl(frontendUrl)`, which compares against
`canonicalProductionUrl` built from `metaConfig.appDomain = 'tau.new'`. The Pages workflow sets
`TAU_FRONTEND_URL: https://3dd.ahmadjalil.com`, the comparison fails, and the routes take their
non-production branch: staging robots (`Disallow: /`) and an empty urlset.

This is inherited upstream behaviour that is correct for upstream and wrong here. It is also the
cheapest high-impact fix in this document — the sitemap generator already has the full model list
from `listStaticPrerenderPaths()`, it is only being told not to use it.

### F6: `404.html` is unstyled and its redirect shim is dead

The emitted `404.html` carries a script that rewrites `/tau`-prefixed paths (a GitHub Pages project-page
concern) and then renders a bare `<p>Page not found. <a href="/">Open Tau CAD Gallery</a></p>` with no
stylesheet, no theme, and no app shell. The site serves from a custom domain at the root, so the shim
never fires; what remains is a browser-default page. Anyone following a stale or mistyped model link —
including the renamed-id case in F17 — lands there.

## Findings — Responsive and Layout

### F7: Engine filter chips overflow and clip at tablet widths

At 820 × 1180 the engine chip row measures `right: 846` against a 820 px viewport. `overflow-x-hidden`
on `<main>` swallows the excess rather than scrolling it, so the last chip (`Replicad`) is visually
cut and unreachable — there is no way to filter by it at that width.

The chips switch on at `md` (768 px) but the five current engines need roughly 1000 px alongside the
search field and category select. Every engine added makes the clipped band wider. The mobile
dropdown already handles this case correctly; the breakpoint is simply in the wrong place.

### F8: Posters that are not 16:9 break the card grid's rhythm

Measured at 1440 × 900:

| Card                | Media box   | Ratio | Poster intrinsic | Card height |
| ------------------- | ----------- | ----- | ---------------- | ----------- |
| 3D Rack System      | 401 × **287** | 1.40 | 919 × 655       | **417**     |
| Atmospheric Sampler | 401 × 225   | 1.78  | 1280 × 655       | 417         |
| Card Holder Grid    | 401 × 225   | 1.78  | (placeholder)    | 417         |
| Catan Box Insert    | 401 × 225   | 1.78  | (placeholder)    | 355         |

`mediaClasses` asks for `sm:aspect-video`, but the media element is a flex item with `shrink-0` and
the default `min-height: auto`, so a poster whose intrinsic ratio is taller than 16:9 sets the floor
and the aspect ratio is ignored. The result is visible as ragged title baselines within a row — the
3D Rack card's heading sits 62 px below its neighbours'.

### F9: Six of fourteen cards have no poster

`Card Holder Grid`, `Catan Box Insert`, `Custom Tray System`, `Customizable Keyguard`,
`Interlocking Boxes System`, and `Pleated Pendant Lamp` render the generic box glyph. On desktop that
is a 401 × 225 empty rectangle per card; on mobile it is a 112 px grey square. A gallery is a visual
index, and 43% of it is currently a placeholder.

The overlap with F1 is near-total and is the most useful signal in this document: **all five models
that fail to render are among these six**, and the only poster-less model that does render is
`Catan Box Insert`. The poster pipeline and the browser are failing on the same set. Treat the
missing poster as a symptom of F1 rather than a separate content gap — fix the renders and the
posters should follow, leaving `catan-insert` as the single genuine content omission.

### F10: Everything below 1280 px gets the phone layout

The model page splits side-by-side at `xl` (1280 px). Measured canvas sizes:

| Viewport   | Canvas       | Parameters                    |
| ---------- | ------------ | ----------------------------- |
| 390 × 844  | 390 × 736    | behind a tab                  |
| 820 × 1180 | 820 × 1123   | behind a tab                  |
| 1280 × 800 | 919 × 743    | 360 px pane, visible          |
| 1440 × 900 | 1079 × 843   | 360 px pane, visible          |

At 820 px the viewer is 1123 px tall with the model floating in the middle of it and the parameters
hidden, despite there being room for a 360 px pane and a still-generous 460 px viewer. iPad portrait,
iPad landscape (1024), and 11–12" laptops all land in this band. Dropping the split to `lg` (1024) —
or to a `min-width: 900px` container query — recovers the parameter pane for every tablet in
landscape without touching the phone layout.

### F11: On mobile the model and its parameters are mutually exclusive

The bottom bar switches between `3D View` and `Parameters`; the inactive pane is `max-xl:hidden`. So
on a phone you drag `Knub Height`, see nothing, tap `3D View`, and evaluate the result from memory.
For a parametric CAD gallery that is the whole interaction loop, broken.

**The fix already exists in this repo.** `apps/ui/app/routes/projects_.$id_.preview/preview-mobile.tsx`
keeps the viewer mounted full-bleed and raises the parameters in a `vaul` drawer at snap points
`[0.5, 0.85]` (`use-preview-state.ts`), padding the viewer by the drawer's height so the model stays
visible and re-fits above it. It carries the same `3D | Params` toggle, pinned top-centre where it
does not fight the drawer. Adopting that component's pattern in the playground is a smaller change
than the current tab machinery and strictly better on a phone.

### F12: Export is unreachable from the Parameters tab on mobile

Below `xl` the export control is portalled onto the viewer (`mobileExportSlot`, stacked above the
toolbar) rather than into the header. That keeps a crowded header readable, which is right — but it
also means the entire download path disappears the moment you switch to Parameters. The likely
sequence on a phone is "adjust parameters, then download", and it dead-ends. Resolving F11 dissolves
this one too, since the viewer stays mounted.

### F13: Parameter rows keep desktop density on touch devices

Measured control heights at 390 × 844 — identical to the 1440 px values:

| Control                          | Size    |
| -------------------------------- | ------- |
| Numeric field (every row)        | 210 × 22 |
| Select trigger                   | 212 × 31 |
| Search / collapse-all icon buttons | 26 × 26 |
| Upload row's image preview       | 24 × 24 |

`PlaygroundParameters` states the intent in a comment: "the parameters pane is the one surface present
at every breakpoint … so neither control here needs a separate mobile treatment." The measurements
argue otherwise. WCAG 2.2 AA asks for 24 × 24 minimum and platform guidance for 44 × 44; a 22 px
scrub-and-type field is at the floor, and the numeric control is a custom scrubber
(`ParametersNumber` → `ParametersNumberField`, a native `<input>` plus drag) rather than an
`<input type="range">`, so a drag on it competes with the pane's own scroll gesture.

The same control also carries no `role="slider"` / `aria-valuenow`, which `docs/policy/accessibility-policy.md`
asks for ("Inputs and sliders must use native `<input>` elements") and which a Playwright query
confirms: zero `input[type=range]` and zero `input[type=number]` on the page.

### F14: The gallery lightbox is not a real dialog, and is not much of a zoom

Tapping a card thumbnail on mobile opens an image at `role="dialog" aria-modal="true"`. Measured
behaviour:

- Focus is never moved into the dialog — `document.activeElement` remains the trigger button.
- One `Tab` press lands on `Open Atmospheric Sampler`, a link on the page behind the overlay. There is
  no focus trap, and the 28 focusable elements behind the modal are all still reachable.
- Focus is not restored on close (Escape does close it correctly).
- The image renders at 355 × 253 inside a 390 × 844 viewport — 30% of the available height — because
  `max-h-full max-w-full` inside `p-4` fits the 919 × 655 source to width and stops there.

### F15: The gallery has no header, no `h1`, and no way to reach anything else

The page's first heading is the `h2` of the first card. There is no site title, no branding, no theme
toggle (the model page has one; the gallery does not, so a viewer who lands on `/` cannot change
theme), and no link to the docs or to the source repository. `enablePageWrapper: false` removes the
shared chrome and nothing replaces it.

### F16: The model page drops the description the gallery card already has

`project.json` carries `description`, `category`, `tags`, and `author` for every model, and the
gallery card shows the description. Open the model and all of it disappears — the page is the title
and the geometry. On desktop the parameter pane ends with roughly 180 px of empty space below the last
row, which is exactly where that context belongs.

### F22: The gallery scrolls inside a container, not the document

`<main className='h-dvh overflow-x-hidden overflow-y-auto …'>` makes the gallery a fixed-height inner
scroller — measured as one scroll container with the document itself not scrolling. On mobile browsers
that costs real estate: the URL bar only auto-collapses in response to *document* scroll, so a phone
keeps ~60–100 px of browser chrome permanently that a normally-scrolling page would reclaim. It also
opts out of native scroll restoration on back-navigation from a model page, which is the single most
common navigation in this app.

The model page genuinely needs `h-dvh overflow-hidden` — it is an app shell with a fixed viewer. The
gallery is a document and would be better letting the document scroll.

## Findings — Content and Labelling

### F17: Model ids do not match model titles

`/periodic-table` is "Interlocking Boxes System"; `/saboteur-card-holder` is "Card Holder Grid";
`/tray-scad` is "Custom Tray System"; `/3d-rack-scad` is "3D Rack System". These ids are the public,
shareable URLs and they are also the SEO slug. The `-scad` suffixes leak the kernel into the address,
and `periodic-table` describes a model that is not one.

### F18: Parameter labels are raw code identifiers

`Knub Height`, `Knub Radius`, `Svg Adjust 1`, `Svg Adjust 2`, `Wrapper Rect 1`, `DTInside Length`,
`DTAngle`. `toTitleCase` is doing its best with `KnubHeight` and `DTInsideLength`, but the source of
truth is the `.scad` identifier and it shows. "Knub" also appears to be a typo for "Knob" throughout
the stamp project. On a public gallery these are the labels a first-time visitor reads.

### F19: Two unexplained markers in the parameter pane

- Red asterisks on `Wrapper Rect 1*`, `Wrapper Rect 2*`, `Svg Adjust 1*`, `Svg Adjust 2*`. These read
  as required-field or error markers on parameters that have perfectly good defaults.
- Group counts — `STAMP (11)`, `WRAPPER RECT (2)`, `SVG ADJUST (2)` — that do not match the number of
  rows in the group (`STAMP` shows 4). Whatever they count is not legible from the UI.

### F20: Static models offer no download

`atmospheric-sampler` and `pre-chamber-nozzle-insert` render from a pre-built GLB and expose no export
control at all (`exportFormats` empty ⇒ the portal target never mounts). The GLB is right there and
already fetched; "look but do not take" is a strange rule for a 3D-printing gallery, and it is not
signposted.

### F21: The deployed gallery cannot show its own source

`TAU_DISABLE_CODE_EDITOR: 'true'` in `.github/workflows/github-pages.yml` makes `showCodeControls`
false, so the `Code`, `Run`, and `Reset` buttons, the editor pane, and the `⌘↵` shortcut never appear
on the deployed site. For a gallery of OpenSCAD and Replicad models — where the source *is* the
model — there is currently no way to read it, and no link to the project directory in the repo
either. A read-only source view would sidestep the reason the editor was disabled (bundle weight and
the Monaco/LSP graph) while restoring the expectation.

## What Already Works

Worth stating plainly so it does not get "improved" by accident.

- **The desktop model page.** 1079 px viewer, 360 px parameter pane, toolbar bottom-left, gizmo
  bottom-right, export in the header. It is legible, dense in the right places, and needs nothing.
- **No horizontal overflow at any viewport** on any surface, including the 152-parameter keyguard.
- **The viewer toolbar's overflow behaviour.** `useToolbarOverflow` measures against a
  content-independent probe and folds controls into the settings dropdown right-to-left as the pane
  narrows, then restores them when it widens. On a 390 px phone the full control set is still reachable.
- **The mobile bottom bar** honours `env(safe-area-inset-bottom)` and lands within thumb reach; the
  panes measured 63 + 736 + 45 = 844, exactly filling the viewport with no double-scroll.
- **Icon-only Gallery button below `md`**, and the variant toggle's `shortLabel` (`SCAD` / `OCCT`
  rather than `OpenSCAD` / `OpenCASCADE`). Both are the right call.
- **Share** produces a clean URL and confirms with a toast; the local `playgroundShareCodec` keeps the
  parameter delta compact and out of the json-url dependency graph.
- **Dark mode** renders correctly on both the gallery and the model page.
- **The mobile card layout** — flipping to a horizontal row with a 112 px thumbnail below `sm` — is a
  good use of a narrow screen.

## Upstream Status

The fork diverged from `taucad/tau` at `3dfb7763c` (`ci: checkout repository before Claude action`,
2026-06-03). Note that `docs/policy/fork-overlay-policy.md` describes the history as beginning with a
squashed import; that is no longer accurate — the fork carries upstream's full 5,441-commit history
and shares a real merge base, which makes a rebase or merge tractable.

### `taucad/tau` main: nothing to take

Four commits since the divergence, all on 2026-08-15, all scaffolding:

| Commit | Subject |
| ------ | ------- |
| `1723620f7` | feat(root): Add standalone repository creation skill (#236) |
| `38354a6d0` | fix(root): Parameterize create-repo CI runners (#238) |
| `3f7b89c25` | fix(create-repo): preserve release intent (#240) |
| `b0ed135bb` | fix(create-repo): publish candidate tarballs from disk (#241) |

Plus lockfile and `license-deps` churn. No UI, runtime, or kernel changes. Syncing `main` buys nothing.

### `taucad/tau` geospec: where the work actually is

`origin/geospec` is **471 commits ahead of main** and was last pushed today. It is upstream's live
branch. Change distribution:

| Area | Files |
| ---- | ----- |
| `apps/ui` | 730 |
| `docs` | 499 |
| `packages/runtime` | 396 |
| `packages/geospec-engine` | 352 (new) |
| `apps/api` | 281 |
| `libs/tau-examples` | 136 |
| `packages/geospec` | 94 (new) |
| `packages/render` | 75 (new) |

Changes that bear directly on defects measured above:

| Upstream commit | Relevance |
| --------------- | --------- |
| `d8f2d48de` feat(ui): implement projected-corner fitting with `fitMargin` for camera zoom | Directly addresses the model-sits-small-in-a-tall-viewport framing seen at 390 × 844 and 820 × 1180 |
| `2ad6fd721` fix(ui): set dark mode light intensity scale to 1 for proper visibility | Viewer lighting in dark mode |
| `0edfb49f4` fix(ui): use `useLayoutEffect` for camera controls initialization | Camera init flash on mount |
| `69ee2716a` feat(ui): section view perf improvements | The section control is on the playground toolbar |
| `a2981ccf6` fix(ui): keep in-use section-cap materials from LRU eviction | Same surface |
| `3a2eebcb9` fix(ui): remove unsupported WebGPU viewer backend selector | Removes a dead control from viewer settings |
| `7bfa6bd5e` feat(ui): interactive pan/zoom for SVG viewer (Panzoom) | Relevant to the stamp project's SVG artwork slot |

Breaking changes to plan for before any sync:

- `a02c4e9ff` — `useRender` renamed to `useRuntime` with a changed API.
- `516d95c6f` — `@taucad/react` renders source directly and exposes a render lifecycle.
- `e8b2168f5` — `feat(runtime)!: Return ordered artifact sets from exports` (explicitly breaking).
- `c7ea593d5` / `9428a9573` — ESM-only distribution, tsdown upgrade, native ESM outputs.
- `e05966d6e` — `@taucad/react` relicensed to Apache-2.0.

### Rebase cost

74 files are touched by both this fork (since the merge base) and `geospec`. The concentration is
exactly where `fork-overlay-policy.md` predicted trouble — the shared viewer surface rather than the
overlay:

```
apps/ui/app/components/geometry/graphics/three/*   (scene, controls, gltf-mesh, measure-tool, …)
apps/ui/app/components/geometry/cad/*              (cad-viewer, viewer-settings)
apps/ui/app/components/{cad-preview,model-viewer}.tsx
apps/ui/app/machines/{cad,graphics}.machine.ts
apps/ui/app/hooks/use-cad-preview.tsx
packages/react/src/components/geometry/parameters/*
```

`apps/ui/app/routes/playground/**` — the actual overlay — does not appear in the overlap at all, which
confirms the policy's split is working. The cost sits in the core edits the policy already warns
about, and the parameters directory in that list is where F3's fix would land, so upstreaming that
fix is worth more than carrying it locally.

## Recommendations

| #   | Action | Priority | Effort | Impact |
| --- | ------ | -------- | ------ | ------ |
| R1  | Fix the five non-rendering models (F1); start from the `0`-valued enum path in F3, which explains two of them | P0 | Med | High |
| R2  | Surface render failure in the viewer — error text, the kernel message, and a retry — instead of a permanent splash (F2) | P0 | Low | High |
| R3  | Key `robots.txt` / `sitemap.xml` off the deployment's own frontend URL rather than `metaConfig.appDomain` (F5) | P0 | Low | High |
| R4  | Move the model-page split from `xl` to `lg`, or to a container query at ~900 px (F10) | P1 | Low | High |
| R5  | Adopt `preview-mobile.tsx`'s drawer + snap-point pattern in the playground so the model stays visible while parameters change (F11, F12) | P1 | Med | High |
| R6  | Make the engine filter row scroll or wrap between `md` and the width it actually needs (F7) | P1 | Low | Med |
| R7  | Constrain card media to `aspect-video` regardless of poster ratio — `min-h-0` on the media, or absolutely position the image (F8) | P1 | Low | Med |
| R8  | Generate the missing posters (F9); five of six should fall out of R1, leaving only `catan-insert` | P1 | Low | Med |
| R9  | Give the gallery a header: `h1`, theme toggle, docs and repo links (F15) | P1 | Low | Med |
| R10 | Add an `index.mdx` under `content/docs/` so `/docs` resolves, and link it (F4) | P1 | Low | Med |
| R11 | Show description, category, tags, and a repo link on the model page, in the pane's empty space (F16) | P2 | Low | Med |
| R12 | Focus-trap and focus-restore the lightbox; let the image use the viewport (F14) | P2 | Low | Med |
| R13 | Raise touch targets in the parameter pane below `xl`, and give the numeric scrubber slider semantics (F13) | P2 | Med | Med |
| R14 | Rename model ids to match titles, with redirects from the old ids (F17) | P2 | Med | Med |
| R15 | Offer a read-only source view on the deployed gallery, or link each model to its repo directory (F21) | P2 | Low | Med |
| R16 | Let the gallery document scroll instead of an `h-dvh` inner container, so mobile browsers reclaim their chrome (F22) | P3 | Low | Low |
| R17 | Style `404.html` and drop the dead `/tau` redirect shim (F6) | P3 | Low | Low |
| R18 | Offer GLB download for static models (F20) | P3 | Low | Low |
| R19 | Clean up parameter labels and the unexplained asterisk / group-count markers (F18, F19) | P3 | Med | Low |
| R20 | Cherry-pick `d8f2d48de` (camera `fitMargin`) and the dark-mode / camera-init fixes from `geospec`; do not sync `main` | P2 | Med | Med |
| R21 | Correct `fork-overlay-policy.md`'s "squashed import" claim — the fork shares upstream's full history and a real merge base at `3dfb7763c` | P3 | Low | Low |

## Appendix: Reproducing

```bash
# Divergence point and upstream survey
git clone https://github.com/taucad/tau /tmp/upstream
git -C /tmp/upstream log --format='%h %ci %s' main..origin/geospec | head

git remote add upstream https://github.com/taucad/tau
git fetch upstream main
git merge-base main upstream/main        # 3dfb7763c

# Crawl metadata
curl https://3dd.ahmadjalil.com/robots.txt
curl https://3dd.ahmadjalil.com/sitemap.xml
curl -o /dev/null -w '%{http_code}\n' https://3dd.ahmadjalil.com/docs

# Model render sweep — poll each catalogue entry for a drawn canvas
# (see the audit's Playwright harness; models are listed in
#  apps/ui/app/routes/playground/projects/)
```
