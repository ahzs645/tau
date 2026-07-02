---
title: 'OpenSCAD Playground parity review and library-first slimming plan'
description: 'Mobile/desktop interface comparison between the Tau fork and the openscad-playgroundrack fork — which gaps are closed, which remain — plus a recommendation for slimming the monorepo around the engine and parametric view as embeddable libraries.'
status: active
created: '2026-07-02'
updated: '2026-07-02'
category: comparison
related:
  - docs/architecture/root-playground-projects.md
  - docs/architecture/runtime-topology.md
---

# OpenSCAD Playground parity review and library-first slimming plan

Two questions drove this review:

1. **Interface (mobile + desktop):** what is Tau's design still missing to be strictly better than
   the `openscad-playgroundrack` fork (ochafik's OpenSCAD Playground + gallery-first additions)?
2. **Architecture:** the Tau fork carries a lot the gallery/playground deployment doesn't need. What
   should be kept (engine, parametric view), what can go, and how do we lean into the packages as
   libraries?

## 1. Interface comparison

### Where Tau is already ahead

These need no porting work — the playground fork has no equivalent:

- **Live rendering.** Tau re-renders on code/parameter change via the kernel worker; the playground
  needs explicit F5/F6 render passes. (Tau's root playground still honors F5/F7 for muscle memory.)
- **Multi-kernel runtime.** OpenSCAD, Replicad, Manifold, OpenCascade, JSCAD, Zoo/KCL through one
  `@taucad/runtime` worker client vs. the fork's two hand-wired engines (openscad-wasm + occt-wasm).
- **Viewer tooling.** Measurement tool, section/clipping views, orientation gizmo, infinite grid,
  WebGPU backend option, FOV/reset/capture controls, per-view settings. The fork has a
  `<model-viewer>` element with a click-to-cycle axes glb.
- **Parametric editor.** RJSF + JSON-schema driven widgets with unit awareness, parameter groups,
  delta-only persistence, presets (`presets.json`), search. The fork's customizer covers the
  OpenSCAD parameter-set format only.
- **Editor.** Full Monaco language services for OpenSCAD (hover, signatures, go-to-definition,
  include resolution) and a KCL LSP; the fork has Monarch tokens + completions, and falls back to a
  plain textarea on mobile.
- **Mobile app shell.** Tabs + bottom drawer with snap points in the project workspace, and a
  3D/Params segmented toggle + viewer-anchored export in the root playground (ported in earlier
  iterations of this fork).
- **Share links.** Both encode only changed parameters, but Tau live-syncs the `?p=` token to the
  address bar as you drag sliders.

### Gaps closed by this change

| Playground-fork feature               | Tau before                                                              | Now                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Gallery category filter               | Engine filter + text search only                                        | Category dropdown fed by `project.json` `category`                                                                             |
| Tags on cards / tag search            | Metadata existed in `project.json` but was dropped by the loader schema | Tags render as card chips and match gallery search                                                                             |
| Card thumbnails                       | No image support                                                        | Optional `image` field per project (lazy-loaded, build-fails on missing file); `pre-chamber-nozzle-insert` ships `poster.webp` |
| Card click target                     | Small "Open" button                                                     | Whole card is the link (44 px+ touch target on mobile)                                                                         |
| Kiosk / embed via URL (`?editor=off`) | Deployment-wide env flag or localStorage only                           | `?editor=off\|0\|false` on `/playground` disables the editor for that visit; survives Share                                    |

### Remaining gaps (deliberate backlog, roughly in value order)

1. **PWA / offline.** The fork registers a service worker and version-update banner. Tau has the
   version-update toast (gallery) but PWA is commented out in `vite.config.ts` (`TODO: add PWA
back`). Highest-value remaining item for the "no-install CAD" pitch.
2. **Gallery thumbnails at scale.** The `image` field now exists, but only one project has art.
   A headless render script (kernel worker → GLB → screenshot) could stamp posters for every
   project at build time; the fork's blurhash placeholder trick is worth stealing at the same time.
3. **3MF multimaterial colors.** The fork maps model colors to Prusa/Bambu/Orca extruder palettes
   in an export dialog. Tau exports 3MF via the converter but has no material mapping UI.
4. **2D export formats (SVG/DXF).** The fork exports both for 2D models; Tau's converter doesn't
   surface them in the playground export dropdown.
5. **AR flow.** The fork gets AR "for free" from `<model-viewer>` (with mm→m scaling); Tau has an
   iOS AR button in the project workspace but not in the root playground/preview.

Small fork touches consciously **not** ported: render-complete sound, Kanban gallery view,
gallery-local theme toggle (Tau's theme is app-wide), OCCT version dropdown (Tau pins kernels per
release).

## 2. Library-first slimming plan

### What the fork actually needs

The gallery + playground deployment exercises: `packages/{runtime, converter, events, filesystem,
fs-client, memory, rpc, vm, json-schema, types, units, utils}` + `kernels/openscad` +
`packages/react` (hooks) — all already published to npm and browser-worker capable with **no API
server**. Geometry, parameter extraction, and export all run client-side
(`apps/ui/app/machines/cad.machine.ts` → `createRuntimeClient`), which is why the static
(`GITHUB_PAGES=true`) build works.

### SaaS-only layer (candidates to drop or fence off)

| Area                                   | Role                                                      | Needed for gallery/playground?            |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `apps/api`, `apps/api-e2e`             | NestJS + Postgres + Redis + S3 + better-auth SaaS backend | No — auth, cloud saves, chat only         |
| `libs/billing`                         | Tier/entitlement gating                                   | No                                        |
| `libs/chat`                            | AI chat engine (LLM keys)                                 | No                                        |
| `packages/telemetry` + `infra/`        | Observability ingest, Grafana/OTEL compose                | No                                        |
| `libs/lsp` (KCL part)                  | Proxies Zoo LSP through `TAU_API_URL`                     | No (OpenSCAD language services are local) |
| `repos.yaml` + `scripts` repos tooling | Clones 100+ reference repos                               | No — research tooling                     |
| `examples/electron-tau`                | Electron demo (its postinstall breaks sandboxed installs) | No                                        |
| `libs/api-extractor`                   | Replicad API extraction dev tool                          | Build-time only                           |

Recommendation: **don't hard-delete in this fork yet** — upstream sync friction would be severe.
Instead treat the list as the "do not maintain, do not build" set: exclude from CI targets and
`pnpm install` scope where possible, and only prune for real once the fork stops tracking upstream.

### The actual gap in the "embeddable" story

`packages/react` is a stub (one `use-render` hook). The genuinely reusable UI — the parametric
panel (`apps/ui/app/components/geometry/parameters/`), the CAD viewer
(`components/geometry/cad/` + `graphics/three/`), and the converter panel — lives inside `apps/ui`
and is entangled with the app shell (shadcn primitives, dockview, XState editor machine). The
marketing page even lists "Embeddable CadViewer web components" as _coming soon_.

Staged extraction path, cheapest first:

1. Keep building gallery features as thin routes over `CadPreviewViewer` / `PreviewParameters`
   (what the root playground already does — those two components are the de-facto embed API).
2. Move `components/geometry/{parameters,cad,graphics}` into `packages/react`, injecting the few
   shell dependencies (button, tooltip, toast) through a small slot/props interface.
3. Publish that as the real `@taucad/react`, and rebuild the playground route on top of it as the
   reference consumer — at that point "use Tau like a library" is literally how this repo's own
   gallery works.

**Status:** the parametric view (step 2 for `parameters/`) is done — `components/geometry/parameters`
plus its machine, actors, and a vendored copy of the shadcn primitives it needs now live in
`packages/react` behind granular subpath exports (`@taucad/react/parameters`, `/parameters-number`,
`/rjsf-theme`, `/rjsf-utils`, `/rjsf-context`, `/tooltip`), and apps/ui consumes them as a library.
The dependency audit for `cad/` + `graphics/` (~14k LOC) found they must move together (mutual
imports via `webgl-fallback`) with theme/color/feature-flag hooks injected — that is the next phase.
