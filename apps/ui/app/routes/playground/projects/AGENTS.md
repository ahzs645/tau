# AGENTS.md

## Root Playground Project Intake

This directory is the source of truth for root playground and gallery projects. Do not maintain a
manual project registry when adding examples.

## How Discovery Works

- `../projects.ts` uses Vite eager `import.meta.glob` to discover `*/project.json`.
- Each discovered folder becomes one playground example unless its metadata has `"hidden": true`.
- The folder name is the stable model id used by `/?model=<project-id>`.
- Do not add or regenerate `index.json` or `manifest.json`; they are obsolete for this app.
- Do not edit `projects.ts` just to add another project. Only edit it when changing the loader
  contract itself.

## Add A Project

Create a kebab-case folder:

```text
apps/ui/app/routes/_index/projects/<project-id>/
  project.json
  main.scad
```

Minimum `project.json`:

```json
{
  "title": "Project Name",
  "entry": "main.scad",
  "description": "Short gallery and playground description."
}
```

Optional fields include:

```json
{
  "mainFile": "main.ts",
  "kernel": "OpenSCAD",
  "engine": "openscad",
  "language": "scad",
  "exportFormats": ["glb", "stl", "3mf", "obj"],
  "initialParameters": {},
  "presets": [{ "name": "Preset name", "parameters": {} }],
  "hidden": false
}
```

Accepted `kernel` values are `OpenSCAD`, `Replicad`, and `OpenCascade`. Imported OpenSCAD Playground
metadata may use `engine`: `openscad`, `replicad`, `opencascade`, or `occt`.

## Kernel Variants

A project can ship the same model in more than one kernel (e.g. an OpenSCAD original plus a
hand-ported OpenCASCADE version) via a `variants` array; the playground then shows a segmented
kernel toggle and round-trips the selection through `?variant=`:

```json
{
  "entry": "main.scad",
  "variants": [
    { "id": "openscad", "entry": "main.scad" },
    { "id": "opencascade", "entry": "main.occt.ts", "renderTimeout": 120000 }
  ]
}
```

- The variant whose `entry` matches the project `entry` is the default. Per-variant
  `exportFormats` default by kernel (mesh formats for OpenSCAD; mesh + STEP for BRep kernels).
  Variants may also override `previewTessellation` / `previewNativeEdges`.
- Kernel selection needs no extra metadata — a `.ts` entry importing `'opencascade.js'` routes to
  the OpenCascade kernel automatically.
- OCCT ports follow a shared shape: `main.occt.ts` with a camelCase `defaultParams` export, plus a
  per-project `lib/occt-utils.ts` helper set (existing ports: vane-trap, catan-insert,
  pendant-lamp, pre-chamber-nozzle-insert, 3d-rack-scad — copy the closest one). Engraved text has
  no OCCT font engine (`Font_BRepFont` is excluded from the wasm build); reuse 3d-rack-scad's
  `lib/text.ts` stroke-digit font. Parameters/presets do not carry across a variant switch.
- Porting pitfalls (seam overlap, never pass compounds to booleans, BOPAlgo list API, thread
  helpers) are catalogued in `docs/research/openscad-opencascade-project-variants.md`.
- Verify a new variant headlessly: add the project to `specs` in
  `packages/testing/scripts/render-variants.ts`, run it via `npx tsx` from `packages/testing`, and
  compare bounding boxes and screenshots against the original — not just render success. Run
  `pnpm nx run-many -t copy-assets` first or the OCCT kernel wasm and OpenSCAD `text()` fonts are
  missing and both fail silently.

## Source Files

The loader imports raw text source files with these extensions:

```text
.js, .ts, .json, .scad, .svg, .txt
```

TypeScript projects store their source directly as `main.ts` (no `.txt` alias needed) — the loader
raw-imports it and the runtime executes it. These project sources are **excluded from the app's
linter** (`.oxlintrc.json` + `eslint.config.mjs` ignore `routes/playground/projects/*/**`) because
they are illustrative kernel example assets, not app code; they are still type-checked by the app
`tsconfig`. Use `mainFile` only for compatibility aliases (e.g. exposing a differently-named entry to
the runtime).

### This folder is the only home for project code

Every project owns its source under `projects/<id>/`. There is no indirection to a shared example
library: a `libSource` field that resolved code from `@taucad/tau-examples` existed, was never used
by any project, and was removed. If a future project wants to reuse a library-owned example
verbatim, add the mechanism back with its first real consumer rather than ahead of one.

Binary files (`.stl`, `.glb`, `.usdz`, etc.) are not loaded into the editor by this path. If a
project needs binary runtime assets, design that asset path explicitly before adding the project.

## Hidden Projects

`"hidden": true` means the project is kept in the tree but not exported to the root playground or
gallery. Use it for incomplete source. Do not rely on empty folders as placeholders; Git does not
track them and the loader ignores them.

## Verification

After changing this directory or `../projects.ts`, run:

```bash
pnpm nx test ui --watch=false app/routes/_index/projects.test.ts
pnpm nx lint ui --files=app/routes/_index/projects.ts
pnpm nx lint ui --files=app/routes/_index/projects.test.ts
pnpm nx typecheck ui
```

Full details live in `docs/architecture/root-playground-projects.md`.
